/**
 * 内置 skills provider 的契约测试。
 *
 * 关键口径：provider 读的是**本仓真实**的 `skills/<name>/SKILL.md`（不 mock 读取逻辑）；
 * 目录缺失 / frontmatter 缺失 / skill 名非法三种降级各自的行为都必须用真实临时目录跑出来。
 * 宿主 `skills.registerProvider(create)` 收的是 create 工厂并返回注销器（rc.2 实测：
 * packages/skill/skill/src/index.ts 的签名是 `registerProvider(create: (control) => SkillProvider): () => void`），
 * 插件必须把注销器挂到卸载时真的会执行的 effect 上，否则 provider 泄漏在宿主服务里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as plugin from '../index.js'

const { apply, installSkillsProvider, createPackagedSkillProvider, listPackagedSkillCandidates, parseSkillFrontmatter, PACKAGED_SKILLS_ROOT } = plugin

// 钉死期望值，避免断言与实现互相引用。
const EXPECTED_PROVIDER = 'dsh-force-subagent'
const EXPECTED_RANK = 550
const EXPECTED_SOURCE = 'custom'
const PACKAGED_NAMES = [
  'team-adversarial-gatekeeper',
  'team-lead-delegation',
  'team-parallel-dispatch',
  'team-recursive-orchestration',
]
/** 每个 SKILL.md 正文里的关键句：拿到正文才算真的读到了内容，而不是只读到文件名。 */
const KEY_SENTENCES = {
  'team-adversarial-gatekeeper': '团队实现合理性把关审查员',
  'team-lead-delegation': 'Lead 是架构师与总指挥',
  'team-parallel-dispatch': '批量扇出派发',
  'team-recursive-orchestration': '拿到任务先拆分，能派就派',
}

/**
 * 宿主契约：registerProvider 收 create 工厂 `(control) => SkillProvider`。
 * createPackagedSkillProvider 返回的就是这个工厂，测试必须先调用它才拿到 provider 本体。
 */
const makeProvider = (skillsRoot, onError) => createPackagedSkillProvider(skillsRoot, onError)({})

/** 临时 skills 根目录；测试结束回收，避免污染仓库。 */
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'force-subagent-skills-'))
  test.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function writeSkill(root, dirName, contents) {
  await mkdir(join(root, dirName), { recursive: true })
  await writeFile(join(root, dirName, 'SKILL.md'), contents, 'utf8')
}

/** 宿主 skills 服务的口径复刻：registerProvider 返回注销器，注销后该 provider 不再参与枚举。 */
function createSkillsService({ registerThrows = false, noDisposer = false, withEffect = true } = {}) {
  const providers = []
  const effects = []
  const warnings = []
  const service = {
    providers,
    effects,
    warnings,
    registerProvider(create) {
      if (registerThrows) throw new Error('skills service refuses new providers')
      const provider = create({})
      providers.push(provider)
      if (noDisposer) return undefined
      return () => {
        const index = providers.indexOf(provider)
        if (index >= 0) providers.splice(index, 1)
      }
    },
    async listAll() {
      const settled = await Promise.all(providers.map((provider) => provider.list({})))
      return settled.flat()
    },
  }
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (serviceName) => (serviceName === 'skills' ? service : undefined),
  }
  if (withEffect) {
    ctx.effect = (factory, label) => { effects.push({ dispose: factory(), label }) }
    ctx.inject = (deps, callback) => callback({
      skills: service,
      effect: ctx.effect,
      fiber: { uid: 'test-fiber' },
      logger: ctx.logger,
    })
  }
  return { service, ctx, warnings }
}

/** 没有 skills 服务的注入上下文（headless 组合 / 未装 skill 层的宿主）。 */
function createCtxWithoutSkills() {
  const warnings = []
  const effects = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: () => undefined,
    effect: (factory, label) => { effects.push({ dispose: factory(), label }) },
    inject: (deps, callback) => callback({
      effect: (factory, label) => { effects.push({ dispose: factory(), label }) },
      fiber: { uid: 'test-fiber' },
      logger: ctx.logger,
    }),
  }
  return { ctx, warnings, effects }
}

// ── 真实读取本仓 skills/ ────────────────────────────────────────────────────

test('内置 skills：list() 真实返回本仓 4 个 skill 候选，name / description / source / provider / rank / invocation 全部齐全', async () => {
  const create = createPackagedSkillProvider()
  assert.equal(typeof create, 'function', '必须返回 create 工厂，交给宿主 registerProvider 调用')
  const provider = create({})
  assert.equal(provider.name, EXPECTED_PROVIDER, 'provider 名必须固定，宿主靠它归并同名 skill')

  const candidates = await provider.list({})
  assert.deepEqual(candidates.map((item) => item.name).sort(), PACKAGED_NAMES, '本仓 skills/ 有且仅有这 4 个内置 skill')
  assert.equal(basename(PACKAGED_SKILLS_ROOT), 'skills', 'skills 根目录必须叫 skills')
  assert.equal(basename(join(PACKAGED_SKILLS_ROOT, '..')), basename(fileURLToPath(new URL('..', import.meta.url))), 'skills 必须挂在插件自己的包根目录下，不是 tests/ 目录')

  for (const candidate of candidates) {
    assert.equal(typeof candidate.name, 'string')
    assert.ok(candidate.name.length > 0, '候选必须有非空 name')
    assert.ok(candidate.description.length > 0, `内置 skill ${candidate.name} 的 description 不得为空：宿主靠它路由`)
    assert.equal(candidate.source, EXPECTED_SOURCE, `内置 skill 的 source 必须是 ${EXPECTED_SOURCE}`)
    assert.equal(candidate.provider, EXPECTED_PROVIDER, `内置 skill 的 provider 必须是 ${EXPECTED_PROVIDER}`)
    assert.equal(candidate.rank, EXPECTED_RANK, '打包 provider 的 rank 必须固定')
    assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true }, '内置 skill 必须同时对模型与用户开放')
    assert.equal(typeof candidate.locator, 'string')
    assert.ok(candidate.locator.endsWith(candidate.name), `locator 必须是 skill 自己的目录，实际 ${candidate.locator}`)
    assert.ok(candidate.path.endsWith(join(candidate.name, 'SKILL.md')), `path 必须指向 SKILL.md，实际 ${candidate.path}`)
    assert.equal('whenToUse' in candidate, false, '本仓 4 个 SKILL.md 都没有 whenToUse：不得凭空造出该键')
    assert.ok(candidate.metadata.name === candidate.name, 'frontmatter 的 name 必须原样进 metadata')
  }
})

test('内置 skills：get(candidate) 返回 frontmatter 之后的正文、resourceBase 指向 skill 目录、path 指向 SKILL.md', async () => {
  const provider = makeProvider()
  const candidates = await provider.list({})

  for (const name of PACKAGED_NAMES) {
    const candidate = candidates.find((item) => item.name === name)
    const definition = await provider.get(candidate, {})

    assert.equal(definition.name, name)
    assert.equal(definition.description, candidate.description, 'get() 的元数据必须与 list() 一致')
    assert.equal(definition.source, EXPECTED_SOURCE)
    assert.equal(definition.provider, EXPECTED_PROVIDER)
    assert.deepEqual(definition.resourceBase, { kind: 'directory', path: candidate.locator }, '相对资源必须以 skill 目录为基准')
    assert.equal(definition.path, candidate.path, 'path 必须指向该 skill 的 SKILL.md')
    assert.ok(definition.content.includes(KEY_SENTENCES[name]), `正文必须含 ${name} 的关键句「${KEY_SENTENCES[name]}」`)
    assert.ok(definition.content.length > 1000, `${name} 的正文必须是真的说明书，不是一行摘要`)
    assert.ok(!definition.content.includes('---\nname:'), '正文不得残留 YAML frontmatter')
    assert.equal(definition.content.trimStart().startsWith('#'), true, '正文应直接从 markdown 标题开始')
  }
})

// ── frontmatter 解析 ────────────────────────────────────────────────────────

test('parseSkillFrontmatter：解析 name / description / whenToUse 与其它标量 metadata，缺失的键不出现', () => {
  const parsed = parseSkillFrontmatter('---\nname: demo-skill\ndescription: 一句话说明\nwhenToUse: 只在演示时\nlicense: MIT\nversion: 3\n---\n\n正文第一行\n正文第二行\n')
  assert.deepEqual(parsed.metadata, { name: 'demo-skill', description: '一句话说明', whenToUse: '只在演示时', license: 'MIT', version: '3' })
  assert.equal(parsed.body, '正文第一行\n正文第二行\n')

  const minimal = parseSkillFrontmatter('---\nname: demo-skill\ndescription: 一句话说明\n---\n正文\n')
  assert.equal('whenToUse' in minimal.metadata, false, 'frontmatter 里没有 whenToUse 时不得出现该键')
  assert.equal(minimal.body, '正文\n')

  // 引号包裹的值必须剥掉引号：否则 description 带引号，宿主路由文案里就多一圈引号。
  const quoted = parseSkillFrontmatter('---\nname: demo-skill\ndescription: "带 冒号: 的说明"\nwhenToUse: \'单引号值\'\n---\n正文\n')
  assert.equal(quoted.metadata.description, '带 冒号: 的说明')
  assert.equal(quoted.metadata.whenToUse, '单引号值')
})

test('parseSkillFrontmatter：没有 frontmatter / 没有闭合分隔符 / 空输入一律 null（调用方据此跳过该条）', () => {
  assert.equal(parseSkillFrontmatter('正文没有 frontmatter\n第二行\n'), null)
  assert.equal(parseSkillFrontmatter(''), null)
  assert.equal(parseSkillFrontmatter('---\nname: demo-skill\n'), null, 'frontmatter 没有闭合分隔符 = 不可用')
  assert.equal(parseSkillFrontmatter(undefined), null)
  assert.deepEqual(parseSkillFrontmatter('---\n---\n正文\n').metadata, {}, '空 frontmatter 解析成空 metadata，不报错')
})

// ── 真实临时目录上的降级路径 ─────────────────────────────────────────────────

test('skills 根目录不存在（ENOENT）时安静返回空集合：不抛、不告警', async () => {
  const notes = []
  const missing = join(await tempRoot(), 'no-such-skills-dir')

  const candidates = await listPackagedSkillCandidates(missing, { onError: (detail) => notes.push(detail) })
  assert.deepEqual(candidates, [], '本包没有自带 skills 目录时返回空集合')
  assert.deepEqual(notes, [], 'ENOENT 不是故障，不得告警')

  const provider = makeProvider(missing, (detail) => notes.push(detail))
  assert.deepEqual(await provider.list({}), [], 'provider.list 同样安静返回空集合')
  assert.equal(await provider.get({ locator: join(missing, 'whatever'), name: 'whatever' }, {}), undefined, '取不到的 skill 返回 undefined 而不是抛')
  assert.deepEqual(notes, [], `provider 路径也不得告警，实际：${JSON.stringify(notes)}`)
})

test('真实目录上的坏条目：缺 frontmatter 与非法 skill 名各自被跳过并恰好告警一次，好条目照常返回', async () => {
  const root = await tempRoot()
  await writeSkill(root, 'good-skill', '---\nname: good-skill\ndescription: 正常条目\nwhenToUse: 正常场景\n---\n正文\n')
  await writeSkill(root, 'plain-dir-name', '---\ndescription: frontmatter 没写 name\n---\n正文\n')
  await writeSkill(root, 'no-frontmatter', '# 只有正文，没有 YAML frontmatter\n')
  await writeSkill(root, 'bad-name', '---\nname: Bad Name\ndescription: 名字非法\n---\n正文\n')
  await writeSkill(root, 'override-name', '---\nname: NOT a valid name\ndescription: frontmatter 覆盖了目录名但名字非法\n---\n正文\n')
  await mkdir(join(root, 'no-skill-md'), { recursive: true })
  await writeFile(join(root, 'loose-file.md'), '不是目录，不该被当成 skill\n', 'utf8')

  const notes = []
  const candidates = await listPackagedSkillCandidates(root, { onError: (detail) => notes.push(detail) })

  assert.deepEqual(
    candidates.map((item) => item.name).sort(),
    ['good-skill', 'plain-dir-name'],
    '坏条目只跳过自己：好条目照常返回，没有 SKILL.md 的空目录与散落文件都不算 skill',
  )
  const good = candidates.find((item) => item.name === 'good-skill')
  assert.equal(good.whenToUse, '正常场景', 'frontmatter 里的 whenToUse 必须透传')
  assert.deepEqual(good.metadata, { name: 'good-skill', description: '正常条目', whenToUse: '正常场景' }, 'frontmatter 其它标量必须原样进 metadata')
  assert.deepEqual(
    candidates.find((item) => item.name === 'plain-dir-name').metadata,
    { description: 'frontmatter 没写 name' },
    'frontmatter 没写 name 时其它标量仍必须透传',
  )

  assert.equal(notes.length, 3, `三条坏条目各告警一次，实际 ${notes.length} 次：${JSON.stringify(notes)}`)
  assert.equal(notes.filter((detail) => detail.includes('没有 YAML frontmatter')).length, 1, '缺 frontmatter 必须点名并说明已跳过')
  assert.equal(notes.filter((detail) => detail.includes('不符合宿主语法')).length, 2, '两处非法名都必须点名是哪个名字')
  assert.ok(notes.some((detail) => detail.includes('Bad Name')), `非法名必须出现在告警里，实际：${JSON.stringify(notes)}`)
  assert.ok(notes.some((detail) => detail.includes('NOT a valid name')), `frontmatter 覆盖出来的非法名同样要点名，实际：${JSON.stringify(notes)}`)
})

test('真实目录上没有 SKILL.md 的目录：安静略过，不告警', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'empty-dir'), { recursive: true })
  const notes = []
  const provider = makeProvider(root, (detail) => notes.push(detail))

  assert.deepEqual(await provider.list({}), [], '空目录没有 SKILL.md：返回空集合')
  assert.deepEqual(notes, [], `ENOENT 不是故障，不得告警，实际：${JSON.stringify(notes)}`)
})

test('skills 根目录不是目录（ENOTDIR）时经 ctx.logger 只告警一次：重复刷新目录只留一条痕', async () => {
  const root = await tempRoot()
  const notADirectory = join(root, 'not-a-directory.txt')
  await writeFile(notADirectory, '这不是目录\n', 'utf8')

  const { service, ctx, warnings } = createSkillsService()
  const result = installSkillsProvider(ctx, { skillsRoot: notADirectory })
  assert.deepEqual(result, { registered: true, via: 'inject' }, '目录坏了不等于注册失败：provider 仍要挂上去')

  const provider = service.providers[0]
  assert.deepEqual(await provider.list({}), [], '读不到目录时返回空集合，不抛')
  await provider.list({})
  await provider.list({})

  assert.equal(warnings.length, 1, `同一故障经 warnSkills 只留一条痕，实际 ${warnings.length} 次：${JSON.stringify(warnings)}`)
  assert.match(String(warnings[0]), /\[force-subagent\] 内置 skills：/)
  assert.match(String(warnings[0]), /读取内置 skills 目录/)
  assert.ok(String(warnings[0]).includes(notADirectory), '告警必须点名是哪个目录读不到')
  assert.ok(String(warnings[0]).includes('ENOTDIR'), '告警必须带上原始错误码，便于定位真实故障')
})

// ── skills 服务缺失 / 注销器托管 ─────────────────────────────────────────────

test('宿主没有 skills 服务时安静降级：不抛、不告警、不留下 effect', () => {
  const { ctx, warnings, effects } = createCtxWithoutSkills()

  const result = installSkillsProvider(ctx)
  assert.equal(result.via, 'inject', '有 inject 就必须走延迟注入，不能在 apply 阶段硬取服务')
  assert.equal(result.registered, false, '服务缺失时 provider 根本没注册，registered 不得谎报 true')
  assert.deepEqual(warnings, [], `服务缺失不是故障，不得告警，实际：${JSON.stringify(warnings)}`)
  assert.deepEqual(effects, [], '没注册 provider 就不该留下 effect disposer')
})

test('registerProvider 的注销器必须挂到注入 scope 的 effect 上：scope 销毁后内置 provider 不再可用', async () => {
  const { service, ctx, warnings } = createSkillsService()

  const result = installSkillsProvider(ctx)
  assert.deepEqual(result, { registered: true, via: 'inject' })
  assert.equal(service.providers.length, 1, '必须注册一条内置 provider')
  assert.equal(service.effects.length, 1, `注销器必须由注入 scope 的 effect 托管，实际 ${service.effects.length} 条 effect`)
  assert.match(String(service.effects[0].label), /skills/, 'effect 必须带可辨识的 label')
  const before = await service.listAll()
  assert.deepEqual(before.map((item) => item.name).sort(), PACKAGED_NAMES, '销毁前宿主必须能枚举到 4 个内置 skill')

  service.effects[0].dispose()
  assert.equal(service.providers.length, 0, '插件卸载 / 热重载时必须把 provider 从宿主服务里摘掉')
  assert.deepEqual(await service.listAll(), [], '注销后 provider 不再可用')
  service.effects[0].dispose()
  assert.equal(service.providers.length, 0, '注销器必须幂等，重复调用不抛')
  assert.deepEqual(warnings, [], `正常注册与注销都不该告警，实际：${JSON.stringify(warnings)}`)
})

test('退化路径（没有 inject，只能 ctx.get）同样必须托管注销器', async () => {
  const { service, ctx, warnings } = createSkillsService({ withEffect: true })
  delete ctx.inject

  const result = installSkillsProvider(ctx)
  assert.deepEqual(result, { registered: true, via: 'get' })
  assert.equal(service.providers.length, 1)
  assert.equal(service.effects.length, 1, '退化路径没有注入 scope，注销器必须挂到 ctx.effect')

  service.effects[0].dispose()
  assert.equal(service.providers.length, 0, 'ctx.effect 的 disposer 必须真的释放 provider')
  assert.deepEqual(warnings, [], `不得告警，实际：${JSON.stringify(warnings)}`)
})

test('注入上下文没有 effect 通道时如实告警一次：provider 无法随插件卸载释放不是可以沉默的事', () => {
  const service = { providers: [], registerProvider: (create) => { service.providers.push(create({})); return () => {} } }
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (serviceName) => (serviceName === 'skills' ? service : undefined),
    inject: (deps, callback) => callback({ skills: service, fiber: { uid: 'test-fiber' } }),
  }

  const result = installSkillsProvider(ctx)
  assert.equal(result.registered, true)
  assert.equal(service.providers.length, 1)
  assert.equal(warnings.length, 1, `必须如实说明注销器无处安放，实际：${JSON.stringify(warnings)}`)
  assert.match(String(warnings[0]), /effect/)
  assert.match(String(warnings[0]), /\[force-subagent\] 内置 skills：/)
})

test('宿主不提供注销器时插件不得凭空捏造释放路径，也不得告警成故障', () => {
  const { service, ctx, warnings } = createSkillsService({ noDisposer: true })

  const result = installSkillsProvider(ctx)
  assert.deepEqual(result, { registered: true, via: 'inject' })
  assert.equal(service.providers.length, 1)
  assert.equal(service.effects.length, 0, '没有注销器就没有可登记的 disposer：不得伪造一条 effect')
  assert.deepEqual(warnings, [], `宿主不提供注销器不是插件的错，不得告警，实际：${JSON.stringify(warnings)}`)
})

test('registerProvider 抛错时不抛、只告警一次，registered:false', () => {
  const { service, ctx, warnings } = createSkillsService({ registerThrows: true })

  const result = installSkillsProvider(ctx)
  assert.deepEqual(result, { registered: false, via: 'inject' })
  assert.equal(service.providers.length, 0)
  assert.equal(warnings.length, 1, `注册失败只告警一次，实际：${JSON.stringify(warnings)}`)
  assert.match(String(warnings[0]), /provider 注册失败/)
  assert.match(String(warnings[0]), /refuses new providers/, '告警必须带上宿主给出的原始错误文本')
})

test('ctx.get 抛错时（退化路径）同样不抛、只告警一次，registered:false', () => {
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: () => { throw new Error('services are not available yet') },
  }

  const result = installSkillsProvider(ctx)
  assert.deepEqual(result, { registered: false, via: 'get' })
  assert.equal(warnings.length, 1, `只告警一次，实际：${JSON.stringify(warnings)}`)
  assert.match(String(warnings[0]), /读取 skills 服务失败/)
})

// ── apply() 集成：真实插件装配 + 真实 skills 目录 ────────────────────────────

function createApplyHost() {
  const warnings = []
  const skills = createSkillsService()
  const effects = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (serviceName) => (
      serviceName === 'skills' ? skills.service
        : serviceName === 'systemPrompt' ? { section: () => {} }
          : serviceName === 'commands' ? { register: () => {} }
            : undefined
    ),
    on: () => {},
    fiber: { uid: 'test-fiber' },
    settings: { configure: () => () => {} },
    effect: (factory, label) => { effects.push({ dispose: factory(), label }) },
    inject: (deps, callback) => callback({
      skills: skills.service,
      effect: (factory, label) => { effects.push({ dispose: factory(), label }) },
      fiber: ctx.fiber,
      settings: ctx.settings,
      logger: ctx.logger,
    }),
  }
  return { ctx, warnings, skills, effects }
}

test('apply() 会把内置 skills 注册进宿主 skills 服务，且 effect 执行时释放', async () => {
  const host = createApplyHost()

  apply(host.ctx, {})

  const registered = host.skills.service.providers.filter((provider) => provider.name === EXPECTED_PROVIDER)
  assert.equal(registered.length, 1, `apply 必须恰好注册一条 ${EXPECTED_PROVIDER} provider`)
  assert.deepEqual((await registered[0].list({})).map((item) => item.name).sort(), PACKAGED_NAMES, 'apply 之后宿主侧必须能枚举到 4 个内置 skill')

  const skillsEffects = host.effects.filter((item) => /skills/.test(String(item.label)))
  assert.equal(skillsEffects.length, 1, `必须留下一条可执行的注销 effect，实际：${JSON.stringify(host.effects.map((item) => item.label))}`)
  skillsEffects[0].dispose()
  assert.equal(host.skills.service.providers.length, 0, 'effect 执行后 provider 必须消失')
  assert.deepEqual(host.warnings, [], `apply 不得产生任何告警，实际：${JSON.stringify(host.warnings)}`)
})

test('apply() 在宿主没有 skills 服务时同样安静：门禁功能不受影响、不告警', () => {
  const host = createApplyHost()
  host.ctx.inject = (deps, callback) => callback({
    effect: (factory, label) => { host.effects.push({ dispose: factory(), label }) },
    fiber: host.ctx.fiber,
    settings: host.ctx.settings,
    logger: host.ctx.logger,
  })
  host.ctx.get = (serviceName) => (
    serviceName === 'systemPrompt' ? { section: () => {} }
      : serviceName === 'commands' ? { register: () => {} }
        : undefined
  )

  apply(host.ctx, {})

  assert.deepEqual(host.warnings, [], `缺 skills 服务不得告警，实际：${JSON.stringify(host.warnings)}`)
  assert.equal(host.skills.service.providers.length, 0, '没有服务就没有注册')
})
