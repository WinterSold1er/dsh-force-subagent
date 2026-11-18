/**
 * 成员容量的读取 / 写入侧测试（rc.2 口径）。
 *
 * 契约：
 * - rc.2 的「同时活着的成员数」归宿主 subagent 服务管（`subagent` 命名空间的 volatile maxActiveSubagents，
 *   深度由同命名空间的 maxDepth 决定）；agent-team 的 Config 已删除 maxMembers / maxMessageBytes / disposalTimeoutMs，
 *   写进任何 patch 层都会让 agent-team 服务在构造期直接抛 TEAM_INVALID_CONFIG。
 * - 插件因此不再读写任何 cordis.patch.yml：读 = 运行中的 subagent 服务 → settings 文档；写 = settings.update('subagent', {...})，
 *   持久化与即时生效由宿主负责。读不到就如实 source='unknown'，不回退内置默认冒充当前值。
 *
 * 运行：node --test tests/capacity-settings.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const {
  MAX_CAPACITY_LIMIT, CAPACITY_NS, CAPACITY_LIMIT_KEY, CAPACITY_DEPTH_KEY,
  toCapacity, toDepth, readCapacity, setCapacity, capacitySourceLabel, apply,
} = plugin

/** 记录 warn 的最小 ctx；services 只放被测的那几个。 */
function fakeCtx(services = {}) {
  const warnings = []
  return {
    warnings,
    logger: { warn: (message) => warnings.push(message) },
    get: (name) => services[name],
  }
}

/** 宿主 Volatile 字段形状（`Config.maxActiveSubagents.get()`）。 */
const volatileService = (limit, depth) => ({
  config: {
    [CAPACITY_LIMIT_KEY]: { get: () => limit },
    ...(depth === undefined ? {} : { [CAPACITY_DEPTH_KEY]: { get: () => depth } }),
  },
})

/* ────────────────────────── 取值校验 ────────────────────────── */

test('toCapacity：只接受 1..MAX_CAPACITY_LIMIT 的整数，拒绝时说明收到了什么', () => {
  [[1, 1], ['64', 64], [' 1024 ', 1024], ['064', 64], [MAX_CAPACITY_LIMIT, MAX_CAPACITY_LIMIT]]
    .forEach(([raw, expected]) => {
      const parsed = toCapacity(raw)
      assert.equal(parsed.limit, expected, `${JSON.stringify(raw)} 应当合法`)
      assert.equal(parsed.error, undefined)
    })

  ;['', '   ', '0', '-1', '1.5', '1e3', '0x10', 'abc', 'Infinity', 'NaN', MAX_CAPACITY_LIMIT + 1]
    .forEach((raw) => {
      const parsed = toCapacity(raw)
      assert.equal(parsed.limit, undefined, `${JSON.stringify(raw)} 必须被拒绝`)
      assert.match(parsed.error, /取值/, `拒绝必须说明原因：${parsed.error}`)
    })

  assert.match(toCapacity(MAX_CAPACITY_LIMIT + 1).error, new RegExp(String(MAX_CAPACITY_LIMIT)), '护栏上限必须写进拒绝理由')
})

test('toDepth：0 合法（宿主 maxDepth 下界为 0），负数与非整数被拒绝', () => {
  [[0, 0], ['2', 2], [' 3 ', 3], [1024, 1024]].forEach(([raw, expected]) => {
    const parsed = toDepth(raw)
    assert.equal(parsed.depth, expected, `${JSON.stringify(raw)} 的深度取值应当合法`)
  })
  ;['', '-1', '1.5', 'abc'].forEach((raw) => {
    const parsed = toDepth(raw)
    assert.equal(parsed.depth, undefined, `${JSON.stringify(raw)} 的深度取值必须被拒绝`)
    assert.match(parsed.error, /深度/)
  })
})

/* ────────────────────────── 读取当前值 ────────────────────────── */

test('readCapacity：优先读运行中的 subagent 服务，并一并回读深度', () => {
  const ctx = fakeCtx({ subagents: volatileService(1024, 2) })
  assert.deepEqual(readCapacity(ctx), { ok: true, limit: 1024, depth: 2, source: 'service' })
  assert.equal(ctx.warnings.length, 0, '读到当前值不该产生告警')
})

test('readCapacity：服务没有该字段时回退 settings 文档，来源如实标注', () => {
  const ctx = fakeCtx({
    subagents: {},
    settings: { describe: () => [{ ns: CAPACITY_NS, revision: 7, value: { [CAPACITY_LIMIT_KEY]: 32, [CAPACITY_DEPTH_KEY]: 3 } }] },
  })
  const read = readCapacity(ctx)
  assert.equal(read.ok, true)
  assert.equal(read.limit, 32)
  assert.equal(read.depth, 3)
  assert.equal(read.source, 'settings')
  assert.equal(capacitySourceLabel(read.source), 'settings 文档（由宿主写进 profile 层 patch 并即时生效）')
})

test('readCapacity：两处都读不到时 ok:false + 恰好一次 warn，且不用默认值冒充当前值', () => {
  const ctx = fakeCtx({ subagents: {}, settings: { describe: () => [{ ns: 'agent-team', revision: 1, value: { maxTasks: 256 } }] } })
  const read = readCapacity(ctx)
  assert.equal(read.ok, false)
  assert.match(read.error, new RegExp(`${CAPACITY_NS}.${CAPACITY_LIMIT_KEY}`), '错误必须点名读不到的字段')
  assert.equal(ctx.warnings.length, 1, `读不到只许 warn 一次，实际 ${ctx.warnings.length} 次`)
  assert.equal(read.limit, undefined, '读不到不得返回任何冒充的当前值')
  assert.equal(capacitySourceLabel('unknown'), '读不到（宿主未暴露 subagent 服务，也没有 settings 文档里的该命名空间）')
})

/* ────────────────────────── 写入 ────────────────────────── */

/** 记录写入调用的假 settings 服务；写入后假 subagent 服务的 getter 直接读同一份状态，模拟宿主 volatile 字段即时生效。 */
function writableHost({ limit = 8, depth = 1, rejectWith } = {}) {
  const calls = []
  const state = { [CAPACITY_LIMIT_KEY]: limit, [CAPACITY_DEPTH_KEY]: depth }
  const settings = {
    async update(ns, patch) {
      calls.push({ ns, patch })
      if (rejectWith !== undefined) throw new Error(rejectWith)
      Object.assign(state, patch)
      return true
    },
    describe: () => [{ ns: CAPACITY_NS, revision: 2, value: { ...state } }],
  }
  const subagents = {
    config: {
      [CAPACITY_LIMIT_KEY]: { get: () => state[CAPACITY_LIMIT_KEY] },
      [CAPACITY_DEPTH_KEY]: { get: () => state[CAPACITY_DEPTH_KEY] },
    },
  }
  return { calls, state, services: { settings, subagents } }
}

test('setCapacity：写入 subagent 命名空间的 maxActiveSubagents，不产生任何别的命名空间或字段', async () => {
  const host = writableHost()
  const ctx = fakeCtx(host.services)
  const result = await setCapacity(ctx, '64')
  assert.equal(result.ok, true, result.error)
  assert.equal(host.calls.length, 1, '必须恰好一次宿主写入')
  assert.equal(host.calls[0].ns, CAPACITY_NS, '写入目标必须是宿主容量命名空间 subagent')
  assert.deepEqual(Object.keys(host.calls[0].patch), [CAPACITY_LIMIT_KEY], `写入字段只能是 ${CAPACITY_LIMIT_KEY}`)
  assert.equal(host.calls[0].patch[CAPACITY_LIMIT_KEY], 64)
  assert.equal(result.status.state, 'applied', result.status.message)
  assert.equal(result.status.limit, 64)
  assert.equal(result.status.source, 'service')
  assert.match(result.status.message, /宿主持久化并即时生效/)
})

test('setCapacity：带 depth 一并写 maxDepth，字段名与顺序都点名宿主旋钮', async () => {
  const host = writableHost()
  const ctx = fakeCtx(host.services)
  const result = await setCapacity(ctx, 64, { depth: '2' })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(host.calls[0].patch, { [CAPACITY_LIMIT_KEY]: 64, [CAPACITY_DEPTH_KEY]: 2 })
  assert.equal(result.depth, 2)
})

test('setCapacity：非法取值零写入，并说明收到了什么', async () => {
  const host = writableHost()
  const ctx = fakeCtx(host.services)
  for (const raw of ['0', '-5', '1.5', 'abc', '', MAX_CAPACITY_LIMIT + 1]) {
    const result = await setCapacity(ctx, raw)
    assert.equal(result.ok, false, `${JSON.stringify(raw)} 必须被拒绝`)
    assert.match(result.error, /成员容量/)
  }
  assert.equal(host.calls.length, 0, '非法取值不得发起任何宿主写入')
})

test('setCapacity：宿主拒绝写入时把原文交出来，不静默、不冒充成功', async () => {
  const host = writableHost({ rejectWith: 'Config field "maxActiveSubagents" is not volatile' })
  const ctx = fakeCtx(host.services)
  const result = await setCapacity(ctx, 12)
  assert.equal(result.ok, false)
  assert.match(result.error, /is not volatile/, `必须保留宿主原文：${result.error}`)
  assert.equal(host.state[CAPACITY_LIMIT_KEY], 8, '宿主拒绝写入时不得改动配置')
})

test('setCapacity：宿主没有 settings 服务时如实失败，不回退写文件', async () => {
  const ctx = fakeCtx({ subagents: volatileService(16, 1) })
  const result = await setCapacity(ctx, 32)
  assert.equal(result.ok, false)
  assert.match(result.error, /settings 服务/, result.error)
})

/* ────────────────────────── /team-limit 命令接线 ────────────────────────── */

/** 取插件登记的命令定义（不是 mock）。 */
function commandOf(registered, name) {
  const found = registered.filter((definition) => definition.name === name)
  assert.equal(found.length, 1, `必须恰好注册一个 "${name}" 命令`)
  return found[0]
}

function commandHost(services) {
  const registered = []
  const warnings = []
  const sections = []
  const withServices = { systemPrompt: { section: (definition) => { sections.push(definition); return () => {} } }, ...services }
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (name) => (name === 'commands' ? { register: (definition) => registered.push(definition) } : withServices[name]),
    on: () => () => {},
    effect: (factory) => factory(),
    inject: (_deps, callback) => callback({ effect: (factory) => factory(), fiber: { uid: 'test' }, settings: withServices.settings, logger: ctx.logger }),
    fiber: { uid: 'test' },
    settings: withServices.settings ?? { configure: () => () => {} },
  }
  return { ctx, registered, warnings, sections }
}

test('/team-limit 不带参数：读当前容量与深度并点名来源', async () => {
  const host = commandHost({ subagents: volatileService(1024, 2) })
  apply(host.ctx, {})
  const command = commandOf(host.registered, 'team-limit')
  const result = await command.handler({ rawInput: '' })
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /1024/)
  assert.match(result.text, /嵌套深度上限 2/)
  assert.match(result.text, /运行中的 subagent 服务/)
})

test('/team-limit 带整数：经 settings 写入 subagent 命名空间，命令文案不再声称写配置文件', async () => {
  const host = commandHost(writableHost().services)
  apply(host.ctx, {})
  const command = commandOf(host.registered, 'team-limit')
  const result = await command.handler({ rawInput: '64' })
  assert.equal(result.kind, 'success', result.text)
  assert.equal(host.registered.length >= 1, true)
  assert.doesNotMatch(result.text, /cordis\.patch\.yml|cordis|配置文件/, `命令文案不得声称插件写配置文件：${result.text}`)
  assert.match(result.text, /64/)
})

test('/team-limit 带非法值：命令给出错误而不是半生效', async () => {
  const host = commandHost(writableHost().services)
  apply(host.ctx, {})
  const command = commandOf(host.registered, 'team-limit')
  const result = await command.handler({ rawInput: '0' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /成员容量/, result.text)
})

/* ────────────────────────── 不再写 patch 文件：静态证据 ────────────────────────── */

const SOURCE_FILES = ['../index.js', '../client.js']

/** 写 / 改 / 删文件的 API：源码里出现任何一个调用点，就存在「把配置写进文件」的通道。 */
const WRITE_FILE_APIS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync',
  'mkdir', 'mkdirSync', 'chmod', 'chmodSync', 'rm', 'rmSync', 'unlink', 'unlinkSync', 'createWriteStream',
]
/**
 * 只读文件系统 API：内置 skills provider 读 <包目录>/skills/<name>/SKILL.md 走的就是这两个
 * （readdir 枚举 skill 目录、readFile 读正文）。这是**只读**路径：它不产生任何写句柄，
 * 也不构成「往 cordis.patch.yml 写东西」的通道，所以对 index.js 只禁写、不禁读。
 */
const READ_ONLY_FS_APIS = ['readdir', 'readdirSync', 'readFile', 'readFileSync']

/** 调用点口径：`api(` 或 `fs.api(`；带前导单词字符的近似名（perform / confirm / reform）不算。 */
const callSiteRe = (api) => new RegExp(`\\b(?:[A-Za-z_$][\\w$]*\\.)?${api}\\s*\\(`)
/** 纯注释行（行首是双斜线、斜线星号或星号）：这些行只做说明，不是可执行路径。 */
const COMMENT_ONLY_LINE_RE = /^\s*(?:\/\/|\/?\*\/?)/
const NAMED_FS_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]node:fs(?:\/[A-Za-z]+)?['"]/g
/** 非具名引入 node:fs：默认导入 / 命名空间导入 / require / 动态 import 都无法静态核对绑定。 */
const OPAQUE_FS_IMPORT_RES = [
  [/import\s+\*\s*(?:as\s+[\w$]+)?\s*from\s*['"]node:fs/, '命名空间导入 node:fs'],
  [/import\s+[A-Za-z_$][\w$]*\s+from\s*['"]node:fs/, '默认导入 node:fs'],
  [/require\s*\(\s*['"]node:fs/, 'require node:fs'],
  [/\bimport\s*\(\s*['"]node:fs/, '动态 import node:fs'],
]

/**
 * 纯函数（无 IO）：按 index.js 口径返回违规清单，空数组 = 合规。
 * 判定口径：
 * - 一切写 / 改 / 删文件 API 的调用点违规；`open(` 也算违规（打开文件句柄即可写）。
 * - 文件系统导入只允许具名导入只读 API（readdir / readFile 及 Sync 变体）。
 * - `cordis.patch.yml` 出现在**代码行**违规；出现在纯注释行不算——index.js:993 用它标注宿主
 *   bundle 里 `subagent` 命名空间的位置、index.js:1116 声明插件不打开任何 patch 文件，
 *   两处都是证据说明，不是可执行的 patch 读写路径。
 * @param code - 待检查的源码文本
 * @returns 违规说明列表
 */
function indexJsFileApiViolations(code) {
  const violations = []
  for (const line of String(code).split('\n')) {
    if (!line.includes('cordis.patch.yml')) continue
    if (COMMENT_ONLY_LINE_RE.test(line)) continue
    violations.push(`代码行引用 cordis.patch.yml：${line.trim()}`)
  }
  for (const api of WRITE_FILE_APIS) {
    if (callSiteRe(api).test(code)) violations.push(`调用写 / 改 / 删文件 API：${api}(`)
  }
  if (/\bopen\s*\(/.test(code)) violations.push('调用 open(')
  for (const match of String(code).matchAll(NAMED_FS_IMPORT_RE)) {
    for (const raw of String(match[1]).split(',')) {
      const binding = raw.split(/\bas\b/)[0].trim()
      if (binding !== '' && !READ_ONLY_FS_APIS.includes(binding)) violations.push(`导入文件系统 API：${binding}`)
    }
  }
  for (const [re, label] of OPAQUE_FS_IMPORT_RES) {
    if (re.test(code)) violations.push(`${label}（无法静态核对绑定）`)
  }
  return violations
}

/** 面板侧口径不变：client.js 连文件系统都不许碰，文案也不许声称往 patch 文件写东西。 */
function clientFileApiViolations(code) {
  const violations = []
  if (code.includes('node:fs')) violations.push('引用 node:fs')
  if (code.includes('cordis.patch.yml')) violations.push('引用 cordis.patch.yml')
  return violations
}

test('守卫自检：违规样例必须红、合规样例必须绿（本守卫不是空断言）', () => {
  const nonCompliant = [
    "import { readdir, readFile, writeFileSync } from 'node:fs/promises'",
    "await writeFile(join(root, 'cordis.patch.yml'), 'maxMembers: 1')",
    'fs.rmSync(skillsRoot, { recursive: true })',
    "const handle = await open(join(root, 'SKILL.md'), 'w')",
  ].join('\n')
  const violations = indexJsFileApiViolations(nonCompliant)
  assert.ok(violations.length >= 5, `违规样例必须全部被抓出，实际：${JSON.stringify(violations)}`)
  for (const needle of ['writeFile', 'writeFileSync', 'rmSync', 'open(', 'cordis.patch.yml']) {
    assert.ok(violations.some((item) => item.includes(needle)), `违规样例的「${needle}」未被抓出：${JSON.stringify(violations)}`)
  }
  // 同名 API 走默认 / 命名空间导入时也必须红：绑定核对不是唯一防线。
  assert.ok(indexJsFileApiViolations("import fs from 'node:fs'\nfs.writeFileSync(p, x)").length > 0, '默认导入 + fs.writeFileSync 必须红')
  assert.ok(indexJsFileApiViolations("const { appendFileSync } = require('node:fs')").length > 0, 'require node:fs 必须红')

  // 合规样例 = 内置 skills 的真实只读写法：必须绿，否则守卫就是在误伤只读路径。
  const compliant = [
    "import { readdir, readFile } from 'node:fs/promises'",
    'const entries = await readdir(skillsRoot, { withFileTypes: true })',
    "const text = await readFile(join(skillsRoot, name, 'SKILL.md'), 'utf8')",
  ].join('\n')
  assert.deepEqual(indexJsFileApiViolations(compliant), [], `只读加载 skills/<name>/SKILL.md 必须合规，实际：${JSON.stringify(indexJsFileApiViolations(compliant))}`)

  // 近名 decoy：'rm' / 'open' 作为其它单词的组成部分不得误判（证明匹配是调用点口径，不是裸子串）。
  const decoys = [
    'function performWork({ confirm, inform, format }) { return confirm(inform) + format() + reform() }',
    'const reopened = reopen(config); const normalize = normalise(value)',
    '/** 插件不打开任何 cordis.patch.yml；容量写入只走宿主 settings / configForms */',
  ].join('\n')
  assert.deepEqual(indexJsFileApiViolations(decoys), [], `近名与纯注释说明不得误判：${JSON.stringify(indexJsFileApiViolations(decoys))}`)

  assert.deepEqual(clientFileApiViolations("export const x = 1\n// 只读展示"), [], 'client.js 合规样例必须绿')
  assert.deepEqual(clientFileApiViolations("import { readFileSync } from 'node:fs'"), ['引用 node:fs'], 'client.js 碰文件系统必须红')
})

test('插件源码不再引用任何成员上限配置键，也不再打开任何配置文件', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  /** rc.2 的 agent-team 见到这些键会在构造期抛 TEAM_INVALID_CONFIG；插件一律不得再出现它们。 */
  const bannedKeys = ['maxMembers', 'maxMembersStatus', 'maxMessageBytes', 'disposalTimeoutMs']
  const sources = SOURCE_FILES.map((relative) => ({
    relative,
    code: readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'),
  }))
  for (const { relative, code } of sources) {
    for (const needle of bannedKeys) {
      assert.ok(!code.includes(needle), `${relative} 不得再出现「${needle}」：agent-team 的 Config 已删除该字段`)
    }
  }
  // 面板侧：client.js 一律不得引用文件系统或 patch 文件。
  const clientSource = sources.find((item) => item.relative === '../client.js')
  assert.deepEqual(clientFileApiViolations(clientSource.code), [], `client.js 存在文件系统 / patch 通道：${JSON.stringify(clientFileApiViolations(clientSource.code))}`)
  // 服务端：index.js 不得存在任何写、改、删文件的通道；只读加载内置 skills/<name>/SKILL.md 是允许的。
  const indexSource = sources.find((item) => item.relative === '../index.js')
  const indexViolations = indexJsFileApiViolations(indexSource.code)
  assert.deepEqual(indexViolations, [], `index.js 存在文件写入通道：${JSON.stringify(indexViolations)}`)
  // 只读路径必须确实存在（否则「允许只读」这条口径没有证据支撑）：内置 skills 的 SKILL.md 加载在源码里。
  assert.ok(/from 'node:fs\/promises'/.test(indexSource.code), 'index.js 应通过 node:fs/promises 只读加载内置 skills')
})

test('插件 Config 里没有成员上限字段，面板写入不经过本插件命名空间', () => {
  const described = plugin.Config.toJSON ? plugin.Config.toJSON() : undefined
  const properties = described?.properties ?? described?.shape ?? {}
  assert.equal(properties[CAPACITY_LIMIT_KEY], undefined, '本插件 Config 不得再暴露容量字段')
  assert.equal(properties.maxMembers, undefined, '本插件 Config 不得再暴露 maxMembers')
  assert.equal(properties.maxMembersStatus, undefined, '宿主不再回写状态字段')
})
