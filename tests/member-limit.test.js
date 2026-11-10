/**
 * 宿主侧 Agent-Team 成员上限：读取（服务实例 / home patch / profile patch / 内置默认四级回退）、
 * 设置（原子写 + 回读校验 + 运行时改写，不可写就如实说需重启）、非法输入拒绝、
 * 读 / 写失败必须可见且不破坏原文件，以及 /team-limit 命令这条宿主暴露面。
 * 运行：node --test tests/
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MAX_MEMBERS,
  MAX_MEMBER_LIMIT,
  apply,
  applyRuntimeLimit,
  findLimitEntry,
  patchLayerPaths,
  patchLimitText,
  readMemberLimit,
  setMemberLimit,
  writeMemberLimitPatch,
} from '../index.js'

/** 复刻真实 ~/.dsh/cordis.patch.yml 的形状：vectr-hooks 块 + 顶层条目 + rea-mcp 块 + agent-team 覆盖。 */
const HOME_PATCH = `# Home-level user patch for DeepSeek Harness — applied after every bundle
# layer and after each profile's own cordis.patch.yml.

# vectr-hooks-start
# vectr-managed Claude Code hook bridge for DeepSeek Harness (dsh) — re-run \`vectr-dsh-mcp hooks <workspace>\` to update; do not hand-edit inside this block.
- insert:
    - id: hooks-claude-code
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: "/home/csy/Work/twoplus/.claude/settings.json"
# vectr-hooks-end

- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
  config:
    maxConsecutiveWakes: 10
# REA MCP is opt-in: default off (207 tools / ~832KB of tool schemas).
# Enable with DSH_ENABLE_REA=1.
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      disabled: !!js process.env.DSH_ENABLE_REA !== '1'
      config:
        serverName: rea
        transport: stdio
        command: /home/csy/.npm-global/bin/rea
        args:
          - mcp

# agent-team member cap override — applied after bundle and profile patch layers.
- id: agent-team
  config:
    maxMembers: 16
    maxTasks: 256
    maxMessageBytes: 65536
    disposalTimeoutMs: 5000
`

/** 复刻 profile / bundle 层的嵌套形状（agent-team-profile/cordis.patch.yml），值 8。 */
const PROFILE_PATCH = `- id: agent-team-profile
  name: '@deepseek-ai/dsh-experimental-agent-team-profile'
  disabled: true

- insert:
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config:
        maxMembers: 8
        maxTasks: 256
`

const HOME_PATCH_NO_ENTRY = `- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
  config:
    maxConsecutiveWakes: 10
`

const dirs = []

function tempDir(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'fsx-limit-'))
  if (mode !== undefined) chmodSync(dir, mode)
  dirs.push(dir)
  return dir
}

/** 造一层 patch 文件，返回 { dir, home, profile, list }；传 undefined 表示该文件不存在。 */
function layers(homeText, profileText) {
  const dir = tempDir()
  const home = join(dir, 'cordis.patch.yml')
  const profile = join(dir, 'profile-cordis.patch.yml')
  if (homeText !== undefined) writeFileSync(home, homeText, { mode: 0o600 })
  if (profileText !== undefined) writeFileSync(profile, profileText, { mode: 0o600 })
  return {
    dir,
    home,
    profile,
    list: [
      { label: 'home-patch', file: home },
      { label: 'profile-patch', file: profile },
    ],
  }
}

/** 最小宿主 ctx：logger.warn 收进 warnings，get 按需返回服务，缺服务返回 undefined。 */
function createHost({ agentTeams, commands } = {}) {
  const warnings = []
  const registered = []
  const services = {
    agentTeams,
    commands: commands ?? { register: (definition) => { registered.push(definition) } },
    systemPrompt: { section: () => {} },
  }
  const ctx = {
    logger: { warn: (message) => { warnings.push(message) } },
    get: (service) => services[service],
    on: () => {},
    inject: (_deps, callback) => callback({ effect: (fn) => fn(), fiber: { uid: 'test-fiber' }, settings: { configure: () => () => {} }, logger: ctx.logger }),
  }
  return { ctx, warnings, registered }
}

const shown = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))

after(() => {
  for (const dir of dirs) {
    try {
      chmodSync(dir, 0o755)
    } catch (error) {
      if (error?.code !== 'EACCES') throw error
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读上限 1：运行中的服务实例优先于 patch 文件', () => {
  const l = layers(HOME_PATCH, PROFILE_PATCH)
  const host = createHost({ agentTeams: { roster: { maxMembers: 42 } } })
  assert.deepEqual(readMemberLimit(host.ctx, { layers: l.list }), { ok: true, limit: 42, source: 'service' })
  assert.equal(host.warnings.length, 0, '命中真实来源不该 warn')
})

test('读上限 2：没有服务实例 → home 层 patch 的 - id: agent-team → config.maxMembers', () => {
  const l = layers(HOME_PATCH, PROFILE_PATCH)
  const host = createHost()
  assert.deepEqual(readMemberLimit(host.ctx, { layers: l.list }), { ok: true, limit: 16, source: 'home-patch' })
  assert.equal(host.warnings.length, 0)
})

test('读上限 3：home 层没有该条目 → profile 层嵌套 - insert: 形状也能读到', () => {
  const l = layers(HOME_PATCH_NO_ENTRY, PROFILE_PATCH)
  const host = createHost()
  assert.deepEqual(readMemberLimit(host.ctx, { layers: l.list }), { ok: true, limit: 8, source: 'profile-patch' })
  assert.equal(host.warnings.length, 0)
})

test('读上限 4：两层都没有 → 内置默认，且 warn 点名每一层落空原因（不静默降级）', () => {
  const l = layers(undefined, undefined)
  const host = createHost()
  const read = readMemberLimit(host.ctx, { layers: l.list })
  assert.equal(read.ok, true)
  assert.equal(read.limit, DEFAULT_MAX_MEMBERS)
  assert.equal(read.source, 'default')
  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /回退到内置默认/)
  assert.match(host.warnings[0], /不存在/)
})

test('读上限：服务实例上的 maxMembers 不是整数 → 明确 warn 后改用 patch 文件', () => {
  const l = layers(HOME_PATCH)
  const host = createHost({ agentTeams: { roster: { maxMembers: Number.NaN } } })
  const read = readMemberLimit(host.ctx, { layers: l.list })
  assert.deepEqual(read, { ok: true, limit: 16, source: 'home-patch' })
  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /没有整数 maxMembers/)
})

test('读上限：patch 里的取值非法 → 返回点名行号的错误，绝不回退默认', () => {
  const l = layers(HOME_PATCH.replace('maxMembers: 16', 'maxMembers: 十二'))
  const host = createHost()
  const read = readMemberLimit(host.ctx, { layers: l.list })
  assert.equal(read.ok, false)
  assert.match(read.error, /maxMembers 非法/)
  assert.match(read.error, /"十二"/)
  assert.match(read.error, /第 \d+ 行/)
})

test('读上限：patch 文件不可读 → 返回 EACCES 错误而不是静默回退', () => {
  const l = layers(HOME_PATCH)
  const host = createHost()
  chmodSync(l.home, 0o000)
  try {
    const read = readMemberLimit(host.ctx, { layers: l.list })
    assert.equal(read.ok, false)
    assert.match(read.error, /读取 .*cordis\.patch\.yml 失败/)
    assert.match(read.error, /EACCES/)
  } finally {
    chmodSync(l.home, 0o600)
  }
})

test('patchLayerPaths：home 层排在 profile 层之前，且跟随 DSH_HOME / DSH_PROFILE_DIR', () => {
  const dir = tempDir()
  const profileDir = join(dir, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const [first, second] = patchLayerPaths({ DSH_HOME: dir, DSH_PROFILE_DIR: profileDir, DSH_PROFILE: 'web' })
  assert.equal(first.label, 'home-patch')
  assert.equal(first.file, join(dir, 'cordis.patch.yml'))
  assert.equal(second.label, 'profile-patch')
  assert.equal(second.file, join(profileDir, 'cordis.patch.yml'))
})

test('写上限：只改 maxMembers 那一行，注释与 vectr-hooks / rea-mcp 块逐行不动；写回原值逐字节一致', () => {
  const l = layers(HOME_PATCH)
  const before = readFileSync(l.home, 'utf8')
  const warnings = []
  assert.deepEqual(writeMemberLimitPatch(12, { file: l.home, warn: (detail) => { warnings.push(detail) } }), { ok: true, path: l.home, limit: 12, created: false })
  const written = readFileSync(l.home, 'utf8')
  const beforeLines = before.split('\n')
  const writtenLines = written.split('\n')
  assert.equal(writtenLines.length, beforeLines.length, '行数必须不变')
  const changed = beforeLines.map((line, index) => (line === writtenLines[index] ? -1 : index)).filter((index) => index >= 0)
  assert.equal(changed.length, 1, `只能有一行不同，实际 ${changed.length} 行`)
  assert.match(beforeLines[changed[0]], /^\s{4}maxMembers: 16$/)
  assert.match(writtenLines[changed[0]], /^\s{4}maxMembers: 12$/)
  assert.equal(written.includes('vectr-hooks-start') && written.includes('rea-mcp'), true)
  assert.equal(warnings.length, 0)
  assert.equal(findLimitEntry(written).raw, '12')

  assert.equal(writeMemberLimitPatch(16, { file: l.home }).ok, true)
  assert.deepEqual(Buffer.from(readFileSync(l.home)), Buffer.from(before), '写回 16 必须与原文件逐字节一致')
})

test('写上限：文件不存在 → 创建最小 patch 并标注重启生效', () => {
  const dir = tempDir()
  const file = join(dir, 'cordis.patch.yml')
  const res = writeMemberLimitPatch(7, { file })
  assert.equal(res.ok, true)
  assert.equal(res.created, true)
  const text = readFileSync(file, 'utf8')
  assert.equal(findLimitEntry(text).raw, '7')
  assert.match(text, /重启后生效/)
  assert.match(text, /^- id: agent-team$/m)
})

test('写上限：没有该条目 → 追加最小块，原有内容逐字节保留且只出现一个 agent-team 条目', () => {
  const l = layers(HOME_PATCH_NO_ENTRY)
  assert.equal(writeMemberLimitPatch(3, { file: l.home }).ok, true)
  const text = readFileSync(l.home, 'utf8')
  assert.equal(text.startsWith(HOME_PATCH_NO_ENTRY), true, '原有内容必须原样在前')
  assert.equal(text.match(/- id: agent-team/g).length, 1)
  assert.equal(findLimitEntry(text).raw, '3')
})

test('写上限：条目存在但没有 maxMembers → 插进它自己的 config 块，不新增第二个条目', () => {
  const cases = [
    { name: '有 config 无 maxMembers', text: '# keep\n- id: agent-team\n  config:\n    maxTasks: 256\n- id: tool-jobs\n', keep: /maxTasks: 256/ },
    { name: '连 config 都没有', text: '# keep\n- id: agent-team\n  name: agent-team\n- id: tool-jobs\n', keep: /name: agent-team/ },
    { name: '嵌套在 insert 里', text: `- insert:\n    - id: agent-team\n      name: '@deepseek-ai/dsh-experimental-agent-team'\n      config:\n        maxTasks: 256\n`, keep: /maxTasks: 256/ },
  ]
  for (const item of cases) {
    const l = layers(item.text)
    assert.equal(writeMemberLimitPatch(9, { file: l.home }).ok, true, item.name)
    const text = readFileSync(l.home, 'utf8')
    assert.equal(text.match(/- id: agent-team/g).length, 1, `${item.name}：不得出现重复条目`)
    assert.equal(findLimitEntry(text).raw, '9', item.name)
    assert.match(text, item.keep, `${item.name}：既有键必须保留`)
  }
})

test('写上限：值没变就是 unchanged，不动文件时间戳之外的任何字节', () => {
  const l = layers(HOME_PATCH)
  const before = Buffer.from(readFileSync(l.home))
  assert.deepEqual(writeMemberLimitPatch(16, { file: l.home }), { ok: true, path: l.home, limit: 16, unchanged: true })
  assert.deepEqual(Buffer.from(readFileSync(l.home)), before)
})

test('非法输入全部拒绝：0 / 负数 / 小数 / 非数字 / 空 / 布尔 / 对象 / 超大 都不碰 patch 文件', () => {
  const l = layers(HOME_PATCH)
  const before = readFileSync(l.home, 'utf8')
  const host = createHost()
  for (const value of [0, -3, -0.5, 12.5, '12.5', '0', 'abc', '', '   ', '1e3', '1001', 1001, 1e9, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, null, undefined, {}, true]) {
    const res = setMemberLimit(host.ctx, value, { file: l.home, service: undefined })
    assert.equal(res.ok, false, `必须拒绝 ${shown(value)}`)
    assert.equal(typeof res.error, 'string', shown(value))
    assert.ok(res.error.startsWith('成员上限'), shown(value))
    assert.equal(readFileSync(l.home, 'utf8'), before, `拒绝 ${shown(value)} 之后文件必须原样`)
  }
  assert.equal(host.warnings.length, 0, '校验失败不产生降级 warn')
  assert.equal(MAX_MEMBER_LIMIT, 1000)
})

test('写失败（目录只读）：原文件逐字节不变、不留临时文件、错误可见', () => {
  const l = layers(HOME_PATCH)
  const before = Buffer.from(readFileSync(l.home))
  const warnings = []
  chmodSync(l.home, 0o444)
  chmodSync(l.dir, 0o555)
  let res
  try {
    res = writeMemberLimitPatch(12, { file: l.home, warn: (detail) => { warnings.push(detail) } })
  } finally {
    chmodSync(l.dir, 0o755)
  }
  assert.equal(res.ok, false)
  assert.match(res.error, /写入 .*cordis\.patch\.yml 失败/)
  assert.match(res.error, /EACCES/)
  assert.deepEqual(Buffer.from(readFileSync(l.home)), before, '原文件必须逐字节不变')
  assert.deepEqual(readdirSync(l.dir).filter((name) => name.includes('.tmp-')), [], '不得留下临时文件')
  assert.equal(findLimitEntry(readFileSync(l.home, 'utf8')).raw, '16')
})

test('写失败（目标路径是目录）：错误可见且原目录内容不受影响', () => {
  const dir = tempDir()
  const file = join(dir, 'cordis.patch.yml')
  mkdirSync(file)
  writeFileSync(join(file, 'inner.txt'), 'inner')
  const res = writeMemberLimitPatch(12, { file })
  assert.equal(res.ok, false)
  assert.match(res.error, /读取 .* 失败/)
  assert.equal(readFileSync(join(file, 'inner.txt'), 'utf8'), 'inner')
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp-')), [])
})

test('运行时改写：roster.maxMembers 可写 → 即时生效并回读一致，config 同步', () => {
  const l = layers(HOME_PATCH)
  const host = createHost({ agentTeams: { roster: { maxMembers: 16 }, config: { maxMembers: 16 } } })
  const service = host.ctx.get('agentTeams')
  const res = setMemberLimit(host.ctx, '12', { file: l.home })
  assert.equal(res.ok, true)
  assert.equal(res.runtime.applied, true)
  assert.match(res.runtime.reason, /运行时已生效/)
  assert.equal(service.roster.maxMembers, 12, '判定处必须真的变了')
  assert.equal(service.config.maxMembers, 12, '同一份限额声明不能停在旧值')
  assert.equal(findLimitEntry(readFileSync(l.home, 'utf8')).raw, '12')
  assert.equal(readMemberLimit(host.ctx, { layers: l.list }).limit, 12)
  assert.equal(host.warnings.length, 0)
})

test('运行时改写：maxMembers 不可写 → 如实返回需重启，不谎称生效', () => {
  const l = layers(HOME_PATCH)
  const roster = {}
  Object.defineProperty(roster, 'maxMembers', { value: 16, writable: false })
  const host = createHost({ agentTeams: { roster } })
  const res = setMemberLimit(host.ctx, 12, { file: l.home })
  assert.equal(res.ok, true, '持久化成功，运行时改不动不是写入失败')
  assert.equal(res.runtime.applied, false)
  assert.match(res.runtime.reason, /不可写/)
  assert.match(res.runtime.reason, /重启/)
  assert.equal(roster.maxMembers, 16, '运行时确实没变')
  assert.equal(findLimitEntry(readFileSync(l.home, 'utf8')).raw, '12')
  assert.ok(host.warnings.some((warning) => /运行时未即时生效/.test(warning)), '必须 warn 出需重启')
})

test('运行时改写：对象已冻结 → 如实返回不可写 / 需重启，不改值', () => {
  const roster = Object.freeze({ maxMembers: 16 })
  const res = applyRuntimeLimit({ roster }, 12)
  assert.equal(res.applied, false)
  assert.match(res.reason, /不可写/)
  assert.match(res.reason, /重启/)
  assert.equal(roster.maxMembers, 16)

  const sealed = Object.seal({ maxMembers: 16 })
  const sealedRes = applyRuntimeLimit({ roster: sealed }, 12)
  assert.equal(sealedRes.applied, true, 'seal 只锁属性可配置性，不锁写，所以生效是正确结论')
  assert.equal(sealed.maxMembers, 12)
})

test('运行时改写：没有服务实例 → 持久化仍然成功，运行时如实标注需重启', () => {
  const l = layers(HOME_PATCH)
  const host = createHost()
  const res = setMemberLimit(host.ctx, 20, { file: l.home })
  assert.equal(res.ok, true)
  assert.equal(res.runtime.applied, false)
  assert.match(res.runtime.reason, /agentTeams 服务实例/)
  assert.match(res.runtime.reason, /重启/)
  assert.equal(findLimitEntry(readFileSync(l.home, 'utf8')).raw, '20')
  assert.ok(host.warnings.some((warning) => /运行时未即时生效/.test(warning)))
})

test('持久化失败时不改运行时：避免只改一半状态', () => {
  const l = layers(HOME_PATCH)
  const service = { roster: { maxMembers: 16 }, config: { maxMembers: 16 } }
  chmodSync(l.dir, 0o555)
  let res
  try {
    res = setMemberLimit(createHost().ctx, 12, { file: l.home, service })
  } finally {
    chmodSync(l.dir, 0o755)
  }
  assert.equal(res.ok, false)
  assert.equal(service.roster.maxMembers, 16, '写不进文件就不动运行时')
})

test('patchLimitText 是纯函数：不碰文件，输出能被 findLimitEntry 读回', () => {
  const next = patchLimitText(HOME_PATCH, 5)
  assert.equal(findLimitEntry(next).raw, '5')
  assert.equal(findLimitEntry(HOME_PATCH).raw, '16', '原文不能被改动')
  assert.equal(findLimitEntry('# 只有注释\n'), undefined)
})

test('/team-limit 命令：与 /using-agent-team 一起注册，读 / 写 / 非法输入三种返回都可见', () => {
  const l = layers(HOME_PATCH)
  const host = createHost()
  const saved = { home: process.env.DSH_HOME, profileDir: process.env.DSH_PROFILE_DIR, profile: process.env.DSH_PROFILE }
  process.env.DSH_HOME = l.dir
  process.env.DSH_PROFILE_DIR = join(l.dir, 'missing-profile')
  process.env.DSH_PROFILE = 'web'
  try {
    apply(host.ctx)
    const names = host.registered.map((definition) => definition.name)
    assert.deepEqual(names, ['using-agent-team', 'team-limit'])
    const definition = host.registered.find((item) => item.name === 'team-limit')
    assert.match(definition.description, /成员上限/)
    assert.equal(typeof definition.handler, 'function')

    const read = definition.handler({ rawInput: '' })
    assert.equal(read.kind, 'success')
    assert.match(read.text, /成员上限：16/)
    assert.match(read.text, /cordis\.patch\.yml/)

    const write = definition.handler({ rawInput: ' 12 ' })
    assert.equal(write.kind, 'success')
    assert.match(write.text, /成员上限：12/)
    assert.match(write.text, /已写入/)
    assert.match(write.text, /需重启/, '这个 ctx 没有 agentTeams 服务，必须如实说需重启')
    assert.equal(findLimitEntry(readFileSync(l.home, 'utf8')).raw, '12')

    const restored = definition.handler({ rawInput: '16' })
    assert.deepEqual(Buffer.from(readFileSync(l.home)), Buffer.from(HOME_PATCH))

    for (const bad of ['0', '-1', '12.5', 'abc', '99999']) {
      const rejected = definition.handler({ rawInput: bad })
      assert.equal(rejected.kind, 'error', bad)
      assert.match(rejected.text, /设置成员上限失败/)
      assert.match(rejected.text, /成员上限/)
    }
    assert.equal(findLimitEntry(readFileSync(l.home, 'utf8')).raw, '16', '非法输入不能改文件')
  } finally {
    Object.assign(process.env, saved)
  }
})

test('/team-limit 撞名：只 warn 跳过该命令，/using-agent-team 仍然注册', () => {
  const registered = []
  const host = createHost({
    commands: {
      register: (definition) => {
        if (definition.name === 'team-limit') throw new Error('command "team-limit" is already registered in this scope')
        registered.push(definition)
      },
    },
  })
  apply(host.ctx)
  assert.deepEqual(registered.map((definition) => definition.name), ['using-agent-team'])
  assert.ok(host.warnings.some((warning) => /team-limit/.test(warning) && /已被占用/.test(warning)), '撞名必须 warn')
})
