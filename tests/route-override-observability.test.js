/**
 * task-5：workspace / 全局模型覆盖必须可观测（覆盖仍然优先，但不再静默）。
 * 契约（权威）：
 *   1) 覆盖优先不变：注入仍按 resolveRoute 的结果严格覆盖 provider/model，reasoningEffort 仍被删；
 *      本测试文件任何用例都不得因为「留痕」而取消注入。
 *   2) 注入模型 ≠ 会话当前模型 → ctx.logger.warn 恰好一次，正文含四要素：
 *      session id、会话当前模型、注入模型、命中的 workspace key；并投递一条前缀
 *      [team-gate] MODEL_OVERRIDE: 的模型可见 notice（复用软门禁既有通道）。
 *   3) 注入模型 = 会话当前模型 → 零 warn、零 notice。
 *   4) 去重口径 = 「会话 + 注入路由」：同一组合只留痕一次；kind 不同或注入模型不同则各一次。
 *   5) 会话当前模型读不到（无 sessionProjections 服务 / 视图缺该单元 / provider|model 不成对）
 *      → 不比较、不 warn、不投递；读取抛错 → fail-open：warn 恰好一次、注入照常、不抛异常。
 * 会话当前模型的读取口径取宿主真实读面（不是猜字段）：
 *   ctx.sessionProjections.snapshot(session).values.modelSelection 是 wire 视图 { lastUsed, next }，
 *   next = pending ?? lastUsed（packages/core/agent/src/model-selection.ts:86-89），
 *   与宿主 AgentModel.recordedSelection（同文件 :117-120）等价；比较只看 provider + model
 *   （宿主 sameRoute，同文件 :42-44）。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply, sessionModelSelection } = plugin

const COMMAND_NAME = 'using-agent-team'
const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
/** 真实 team/member 事件形状（成员判定只认这里登记的 member.id === childId）。 */
const memberEvent = (id) => ({
  type: 'team/member',
  data: { version: 2, teamId: 'team-1', member: { id, name: `worker-${id}`, role: 'teammate', phase: 'active' } },
})

/** 夹具模型名刻意与真实路由无关，避免任何用例依赖具体模型。 */
const SESSION_ROUTE = { provider: 'prov-lead', model: 'model-lead' }
const MEMBER_ROUTE = { provider: 'prov-member', model: 'model-member' }
const SUBAGENT_ROUTE = { provider: 'prov-sub', model: 'model-sub' }
const WORKSPACE_KEY = '/work/repo-a'
const SESSION_ID = 'session-lead-1'

/** wire 视图形状：{ lastUsed, next }，每项 { provider, model, reasoningEffort? } | null。 */
const modelView = (selection, extra = {}) => ({
  lastUsed: selection === null ? null : { ...selection, ...extra },
  next: selection === null ? null : { ...selection, ...extra },
})

const PROVIDERS = {
  spawn: { name: 'spawn', capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true } },
  acp: { name: 'acp', capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false } },
}

/**
 * 真实形状的最小宿主：subagents 是 cordis 式 traceable Proxy（读方法属性返回新函数 Proxy），
 * 会话模型走 sessionProjections.snapshot。
 * @param projection - undefined = 不提供 sessionProjections 服务；'throw' = snapshot 抛错；
 *                     null = 有服务但视图里没有 modelSelection 单元；函数 = 返回该会话的 modelSelection 视图。
 */
function createHost({ projection } = {}) {
  const warnings = []
  const notices = []
  const startedCalls = []
  const snapshotCalls = []
  const services = {
    systemPrompt: { section: () => {} },
    commands: { register: () => {} },
  }
  if (projection !== undefined) {
    services.sessionProjections = {
      snapshot(session) {
        snapshotCalls.push(session)
        if (projection === 'throw') throw new Error('projection drive unavailable')
        return { asOfSeq: 12, values: projection === null ? {} : { modelSelection: projection(session) } }
      },
    }
  }
  const proto = {
    startActivation: async function (spec) {
      startedCalls.push({ spec, self: this })
      return { kind: 'started' }
    },
    getProvider: function (name) {
      return PROVIDERS[name]
    },
  }
  const backing = Object.create(proto)
  // 真实 cordis 每次 get 都返回新的 traceable Proxy：用工厂表达，避免「同一 Proxy」假绿。
  const createProxy = () => new Proxy(backing, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function'
        ? new Proxy(value, { apply: (fn, thisArg, args) => Reflect.apply(fn, thisArg, args) })
        : value
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value)
    },
    deleteProperty(target, prop) {
      return Reflect.deleteProperty(target, prop)
    },
  })
  services.subagents = createProxy()
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (name) => services[name],
    on: () => {},
    fiber: { uid: 'test-fiber' },
    settings: { configure: () => () => {} },
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: ctx.fiber,
      settings: ctx.settings,
      logger: ctx.logger,
    }),
    effect: (factory) => factory(),
  }
  return { ctx, warnings, notices, startedCalls, snapshotCalls, subagents: createProxy(), backing }
}

/** Lead 会话：真实 Session 暴露 id / cwd；事件面复刻插件用到的读取口。 */
const leadSession = (events) => ({
  id: SESSION_ID,
  cwd: WORKSPACE_KEY,
  header: { id: SESSION_ID, cwd: WORKSPACE_KEY },
  events,
})

/** 发起派发的会话 Agent（真实 Agent 有 inject 这条 notice 通道）。 */
const parentAgent = (host, session) => ({
  id: 'parent-agent-1',
  session,
  inject(message) {
    host.notices.push(message)
  },
})

const childSpec = (agent, { childId, provider = 'spawn', request = {} } = {}) => ({
  delivery: 'parent',
  ...(childId === undefined ? {} : { childId }),
  provider,
  label: 'impl',
  request: { prompt: 'do work', parent: agent, ...request },
  signal: new AbortController().signal,
})

const forwarded = (host) => host.startedCalls.at(-1)?.spec

/** 两类告警必须分开计量：覆盖留痕本体 vs 读取失败兜底，二者不得互相冒充。 */
const overrideWarnings = (host) => host.warnings.filter((message) => String(message).includes('模型覆盖留痕：session='))
const readFailureWarnings = (host) => host.warnings.filter((message) => String(message).includes('当前模型失败'))

const workspaceConfig = (entry) => ({ workspaces: { [WORKSPACE_KEY]: entry } })

test('R1 覆盖 = 会话当前模型：注入照常、零 warn、零 notice', async () => {
  const host = createHost({ projection: () => modelView(SESSION_ROUTE) })
  apply(host.ctx, workspaceConfig({ member: { ...SESSION_ROUTE }, subagent: { ...SESSION_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))

  const seen = forwarded(host)
  assert.deepEqual(
    seen?.request?.agentOptions,
    { provider: SESSION_ROUTE.provider, model: SESSION_ROUTE.model },
    'R1：同模型的覆盖仍必须注入（覆盖优先不得因留痕而失效）',
  )
  assert.deepEqual(host.warnings, [], `R1：注入模型与会话模型一致时不得 warn，实际：${JSON.stringify(host.warnings)}`)
  assert.equal(host.notices.length, 0, `R1：不得投递覆盖 notice，实际 ${host.notices.length} 条`)
})

test('R2 覆盖 ≠ 会话当前模型：恰好一次 warn（含四要素）+ 一条 [team-gate] MODEL_OVERRIDE notice，注入仍生效', async () => {
  const host = createHost({ projection: () => modelView(SESSION_ROUTE) })
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...MEMBER_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  for (let index = 0; index < 3; index += 1) {
    await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))
  }

  const seen = forwarded(host)
  assert.deepEqual(
    seen?.request?.agentOptions,
    { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model },
    'R2：覆盖必须仍然生效（留痕不得改变路由结果）',
  )

  const warns = overrideWarnings(host)
  assert.equal(warns.length, 1, `R2：同一「会话 + 注入路由」必须恰好 warn 一次，实际 ${warns.length} 次：${JSON.stringify(warns)}`)
  const text = String(warns[0])
  assert.match(text, /^\[force-subagent\] /, `R2：warn 必须以 [force-subagent] 前缀开头，实际「${text}」`)
  assert.ok(text.includes(SESSION_ID), `R2：warn 必须含 session id ${SESSION_ID}，实际「${text}」`)
  assert.ok(text.includes(`${SESSION_ROUTE.provider}/${SESSION_ROUTE.model}`), `R2：warn 必须含会话当前模型，实际「${text}」`)
  assert.ok(text.includes(`${MEMBER_ROUTE.provider}/${MEMBER_ROUTE.model}`), `R2：warn 必须含注入模型，实际「${text}」`)
  assert.ok(text.includes(WORKSPACE_KEY), `R2：warn 必须含命中的 workspace key ${WORKSPACE_KEY}，实际「${text}」`)
  assert.deepEqual(host.warnings, warns, `R2：不得产生其它 warn，实际：${JSON.stringify(host.warnings)}`)

  assert.equal(host.notices.length, 1, `R2：覆盖 notice 必须恰好一条，实际 ${host.notices.length} 条`)
  const noticeText = String(host.notices[0]?.content?.[0]?.text ?? '')
  assert.match(noticeText, /^\[team-gate\] MODEL_OVERRIDE:/, `R2：notice 必须走 [team-gate] 提醒通道，实际「${noticeText}」`)
  assert.ok(noticeText.includes(`${MEMBER_ROUTE.provider}/${MEMBER_ROUTE.model}`), `R2：notice 必须点名注入模型，实际「${noticeText}」`)
  assert.ok(noticeText.includes(`${SESSION_ROUTE.provider}/${SESSION_ROUTE.model}`), `R2：notice 必须点名被覆盖的会话模型，实际「${noticeText}」`)
  assert.equal(host.notices[0]?.source?.kind, 'force-subagent', 'R2：notice 必须复用既有 force-subagent notice 形态')
})

test('R3 去重口径是「会话 + 注入路由」：member 与 subagent 各自一次，重复激活不再重复', async () => {
  const host = createHost({ projection: () => modelView(SESSION_ROUTE) })
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...SUBAGENT_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))
  await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))
  await host.subagents.startActivation(childSpec(agent, {}))
  await host.subagents.startActivation(childSpec(agent, {}))

  const warns = overrideWarnings(host)
  assert.equal(warns.length, 2, `R3：两种注入路由各留痕一次，共 2 次，实际 ${warns.length} 次：${JSON.stringify(warns)}`)
  assert.ok(warns.some((message) => message.includes(`${MEMBER_ROUTE.provider}/${MEMBER_ROUTE.model}`)), 'R3：member 路由的留痕必须存在')
  assert.ok(warns.some((message) => message.includes(`${SUBAGENT_ROUTE.provider}/${SUBAGENT_ROUTE.model}`)), 'R3：subagent 路由的留痕必须存在')
  assert.equal(host.notices.length, 2, `R3：notice 与 warn 同一去重口径，实际 ${host.notices.length} 条`)
})

test('R4 未命中 workspace 条目时回退全局路由：同样留痕，并点名未命中的 workspace key', async () => {
  const host = createHost({ projection: () => modelView(SESSION_ROUTE) })
  apply(host.ctx, { member: { ...MEMBER_ROUTE }, workspaces: {} })
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))

  const warns = overrideWarnings(host)
  assert.equal(warns.length, 1, `R4：全局路由覆盖同样必须留痕一次，实际 ${warns.length} 次：${JSON.stringify(warns)}`)
  assert.ok(String(warns[0]).includes(WORKSPACE_KEY), `R4：留痕必须点名 workspace key，实际「${warns[0]}」`)
  assert.match(String(warns[0]), /全局路由/, `R4：留痕必须说明来源是全局路由，实际「${warns[0]}」`)
  assert.equal(host.notices.length, 1, `R4：必须投递一条覆盖 notice，实际 ${host.notices.length} 条`)
})

test('R5 读不到会话当前模型（无 sessionProjections 服务）：不比较、不 warn、不投递，注入照常', async () => {
  const host = createHost()
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...MEMBER_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))

  assert.deepEqual(
    forwarded(host)?.request?.agentOptions,
    { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model },
    'R5：读不到会话模型不得影响注入',
  )
  assert.deepEqual(host.warnings, [], `R5：判定不了就不告警，实际：${JSON.stringify(host.warnings)}`)
  assert.equal(host.notices.length, 0, `R5：不得投递 notice，实际 ${host.notices.length} 条`)
})

test('R6 视图缺 modelSelection 单元：同样不比较、不 warn（单元未注册不是故障）', async () => {
  const host = createHost({ projection: null })
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...MEMBER_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))

  assert.equal(host.snapshotCalls.length, 1, 'R6：必须真的走一次投影读面')
  assert.deepEqual(
    forwarded(host)?.request?.agentOptions,
    { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model },
    'R6：注入不得因读不到模型而取消',
  )
  assert.deepEqual(host.warnings, [], `R6：单元未注册不得 warn，实际：${JSON.stringify(host.warnings)}`)
})

test('R7 投影读取抛错：fail-open —— 注入照常、warn 恰好一次、不抛异常、不刷屏', async () => {
  const host = createHost({ projection: 'throw' })
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...MEMBER_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  for (let index = 0; index < 4; index += 1) {
    await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))
  }

  assert.equal(host.snapshotCalls.length, 4, 'R7：每次激活都重新读一次投影（不缓存失效结果）')
  assert.deepEqual(
    forwarded(host)?.request?.agentOptions,
    { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model },
    'R7：读取失败必须 fail-open，注入照常',
  )
  const warns = readFailureWarnings(host)
  assert.equal(warns.length, 1, `R7：读取失败只 warn 一次，实际 ${warns.length} 次：${JSON.stringify(host.warnings)}`)
  assert.match(String(warns[0]), /当前模型失败/, `R7：warn 必须点名失败原因，实际「${warns[0]}」`)
  assert.ok(String(warns[0]).includes(SESSION_ID), `R7：warn 必须点名会话，实际「${warns[0]}」`)
  assert.equal(overrideWarnings(host).length, 0, 'R7：读不到模型时不得伪造覆盖留痕')
  assert.equal(host.notices.length, 0, `R7：读失败路径不投递覆盖 notice，实际 ${host.notices.length} 条`)
})

test('R8 外部 provider（capabilities.agentOptions=false）：不注入也不留痕', async () => {
  const host = createHost({ projection: () => modelView(SESSION_ROUTE) })
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...MEMBER_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))
  const original = childSpec(agent, { childId: 'child-1', provider: 'acp' })

  await host.subagents.startActivation(original)

  assert.equal(forwarded(host), original, 'R8：外部 provider 的 spec 必须原样转发')
  assert.deepEqual(host.warnings, [], `R8：不注入就不留痕，实际：${JSON.stringify(host.warnings)}`)
})

test('R9 会话关闭（无 /using-agent-team 记录）：不注入也不留痕', async () => {
  const host = createHost({ projection: () => modelView(SESSION_ROUTE) })
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...MEMBER_ROUTE } }))
  const agent = parentAgent(host, leadSession([]))

  await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))

  assert.equal(forwarded(host)?.request?.agentOptions, undefined, 'R9：关闭状态不得注入')
  assert.deepEqual(host.warnings, [], `R9：关闭状态不得留痕，实际：${JSON.stringify(host.warnings)}`)
})

test('R10 比较只看 provider + model：投影里的 reasoningEffort 不参与判定（与宿主 sameRoute 同判据）', async () => {
  const host = createHost({ projection: () => modelView(SESSION_ROUTE, { reasoningEffort: 'high' }) })
  apply(host.ctx, workspaceConfig({ member: { ...SESSION_ROUTE }, subagent: { ...SESSION_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))

  assert.deepEqual(host.warnings, [], `R10：档位不同不是模型覆盖，不得 warn，实际：${JSON.stringify(host.warnings)}`)
  assert.equal(forwarded(host)?.request?.agentOptions?.reasoningEffort, undefined, 'R10：reasoningEffort 仍必须被删除')
})

test('R11 next 优先于 lastUsed：会话刚切换模型（pending 生效）时按 next 判定', async () => {
  const host = createHost({
    projection: () => ({ lastUsed: { ...SESSION_ROUTE }, next: { ...MEMBER_ROUTE } }),
  })
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...MEMBER_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))

  assert.deepEqual(host.warnings, [], `R11：注入模型已等于会话当前选择（next），不得 warn，实际：${JSON.stringify(host.warnings)}`)
})

test('R12 只有 lastUsed 时回退 lastUsed（宿主 pending ?? lastUsed 口径）', async () => {
  const host = createHost({
    projection: () => ({ lastUsed: { ...SESSION_ROUTE }, next: null }),
  })
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...MEMBER_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))

  const warns = overrideWarnings(host)
  assert.equal(warns.length, 1, `R12：lastUsed 必须作为会话当前模型，实际 ${warns.length} 次`)
  assert.ok(String(warns[0]).includes(`${SESSION_ROUTE.provider}/${SESSION_ROUTE.model}`), `R12：留痕必须点名 lastUsed 模型，实际「${warns[0]}」`)
})

test('R13 留痕失败不得抛异常：logger.warn 抛错时注入仍完成、startActivation 不抛', async () => {
  const host = createHost({ projection: () => modelView(SESSION_ROUTE) })
  let thrown = 0
  host.ctx.logger = {
    warn() {
      thrown += 1
      throw new Error('logger sink broken')
    },
  }
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...MEMBER_ROUTE } }))
  const agent = parentAgent(host, leadSession([runEvent('on'), memberEvent('child-1')]))

  const result = await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))

  assert.deepEqual(result, { kind: 'started' }, 'R13：留痕失败绝不能影响 startActivation 的返回值')
  assert.ok(thrown >= 1, 'R13：确实走过了告警分支')
  assert.deepEqual(
    forwarded(host)?.request?.agentOptions,
    { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model },
    'R13：告警 sink 抛错时注入仍必须发生',
  )
})

test('R14 会话 Agent 没有 inject 通道：warn 仍留痕，投递失败只 warn 一次且不影响注入', async () => {
  const host = createHost({ projection: () => modelView(SESSION_ROUTE) })
  apply(host.ctx, workspaceConfig({ member: { ...MEMBER_ROUTE }, subagent: { ...MEMBER_ROUTE } }))
  const agent = { id: 'parent-agent-no-inject', session: leadSession([runEvent('on'), memberEvent('child-1')]) }

  for (let index = 0; index < 3; index += 1) {
    await host.subagents.startActivation(childSpec(agent, { childId: 'child-1' }))
  }

  assert.equal(overrideWarnings(host).length, 1, 'R14：覆盖留痕仍必须恰好一次')
  assert.equal(
    host.warnings.filter((message) => String(message).includes('无 inject 方法')).length,
    1,
    `R14：投递通道缺失只 warn 一次，实际：${JSON.stringify(host.warnings)}`,
  )
  assert.deepEqual(
    forwarded(host)?.request?.agentOptions,
    { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model },
    'R14：投递失败不得取消注入',
  )
})

test('R15 sessionModelSelection 单元：读 wire 视图 next ?? lastUsed，判定不了返回 undefined', () => {
  const seen = []
  const ctx = {
    get: (name) => {
      seen.push(name)
      return name === 'sessionProjections'
        ? { snapshot: () => ({ asOfSeq: 1, values: { modelSelection: { lastUsed: { provider: 'p1', model: 'm1' }, next: null } } }) }
        : undefined
    },
  }

  assert.deepEqual(sessionModelSelection(ctx, { id: 's1' }), { provider: 'p1', model: 'm1' }, 'R15：next 为 null 时必须回退 lastUsed')
  assert.deepEqual(seen, ['sessionProjections'], 'R15：必须经 ctx.get("sessionProjections") 这条真实服务口读取')

  const broken = {
    get: () => ({ snapshot: () => { throw new Error('fold failed') } }),
  }
  const errors = []
  assert.equal(sessionModelSelection(broken, { id: 's1' }, (error) => errors.push(error.message)), undefined,
    'R15：snapshot 抛错必须返回 undefined 并把 error 交给 onFailure')
  assert.deepEqual(errors, ['fold failed'], 'R15：onFailure 必须收到原始 error')

  assert.equal(sessionModelSelection({ get: () => undefined }, { id: 's1' }), undefined, 'R15：服务缺失返回 undefined（不是故障）')
  assert.equal(sessionModelSelection({ get: () => ({}) }, { id: 's1' }), undefined, 'R15：无 snapshot 方法返回 undefined')
  assert.equal(sessionModelSelection({ get: () => undefined }, undefined), undefined, 'R15：无会话返回 undefined')
  const malformed = { get: () => ({ snapshot: () => ({ values: { modelSelection: { lastUsed: { provider: '', model: 'm' }, next: null } } }) }) }
  assert.equal(sessionModelSelection(malformed, { id: 's1' }), undefined, 'R15：provider 为空串时判定不了，返回 undefined')
})
