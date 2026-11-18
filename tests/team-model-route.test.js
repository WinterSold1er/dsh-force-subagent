/**
 * dsh-force-subagent 子代理模型路由注入测试。
 *
 * 入参形状以 **DSH 0.2.2-rc.2 真实形状**为准：`SubagentActivationSpec extends
 * Omit<SubagentStartRequest, 'label' | 'signal'>`（宿主 packages/subagent/subagent/src/types.ts:29）
 * 是**扁平**的——provider / label / name? / childId? / signal / delivery 与 parent / prompt / agentOptions
 * 同在顶层；调用点 tool-subagent/src/index.ts:317-333 用 `{ provider, label, ...request, signal, delivery }`
 * 展开，外部调用既不传 childId，也没有 `request` 包装键。rc.1 的 `spec.request` 包装只在
 * 「兼容写回」用例（x 组）里出现，用来锁定旧形状仍被同步更新，但它不是生产形状。
 *
 * 契约：apply() 用 ctx.effect 包裹 ctx.get('subagents').startActivation。
 * 命中条件只有两个：root 会话 /using-agent-team 已开启，且 spec.provider 对应的 provider 经公开访问器
 * `subagents.getProvider(name)` 查到且 `capabilities.agentOptions === true`。
 * 成员判定：带 childId 时优先 team/member 名册；rc.2 不带 childId，只能用 parent 身份推断
 * （root/Lead 直接派的子级是成员，teammate 再派的下级与身份不可解析的父走 subagent 路由）。
 * 命中时严格覆盖 provider/model 并删除 reasoningEffort，其余 agentOptions 字段保留；
 * 注入落在**顶层** agentOptions（宿主 manager.ts:340 只读顶层）；入参 spec 不被就地改写，
 * 其余 spec 字段、返回值、异常语义原样透传。
 * 拿不到 provider（getProvider 缺失 / 返回 undefined / 非对象）→ fail-open 不注入、不 warn。
 * 会话事件不可读（commandState 抛 TypeError）或 getProvider 抛错 → fail-open：不注入、不抛、只 warn 一次。
 * dispose 必须 delete 本插件写入的自有方法（真实宿主方法经 traceable Proxy 读取，不能做身份比较），
 * 让宿主 prototype 方法恢复；重复 apply 不得叠加包裹。
 *
 * 运行：node --test tests/team-model-route.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin
/** 默认路由字面值：钉死，避免断言与实现自引用。 */
const ROUTE = { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }
const COMMAND_NAME = 'using-agent-team'
/** 与真实故障工作区同形的 key（会话 cwd）。 */
const WORKSPACE_KEY = '/home/csy/Code/Github/strata-platform'
/** 配置里要落下去的路由：与默认路由必须不同，否则断言无法证明「配置生效」。 */
const MEMBER_ROUTE = { provider: 'minor-5090', model: 'qwen3.8-flash-next-iq3_xxs' }
const SUBAGENT_ROUTE = { provider: 'minor-5090', model: 'qwen3.8-flash-plain' }

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const memberEvent = (id) => ({ type: 'team/member', data: { member: { id } } })
const leadSession = (events) => ({ events })
const onSession = () => leadSession([runEvent('on')])
/** 带 cwd 的 Lead 会话：真实 Session 同时暴露 cwd 与 header.cwd，工作区 key 由此而来。 */
const cwdSession = (events, cwd = WORKSPACE_KEY) => ({ events, cwd, header: { cwd } })

/** provider 注册表的真实形状：capabilities.agentOptions 才是「能不能收子代理 agentOptions」的判据。 */
const PROVIDERS = {
  spawn: { name: 'spawn', capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true } },
  fork: { name: 'fork', capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true } },
  acp: { name: 'acp', capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false } },
  bare: { name: 'bare' },
}

/** 插件的边界只有两个：ctx（宿主上下文）与 session（会话事件来源），其余都是真实实现。 */
function createHost({ withSubagents = true, withGetProvider = true, withRootOf = true } = {}) {
  const warnings = []
  const disposers = []
  const startedCalls = []
  let getProviderThrows = false
  // 复刻真实宿主（cordis 4.0.5）的 traceable Proxy：读方法属性每次返回新的函数 Proxy
  // （apply 转发到真实方法并保留 this），set / delete 转发到 backing 对象；每次 get 返回新对象。
  // 裸对象 fake 会让对象身份恒等式假绿，掩盖「disposer 永不还原」的缺陷。
  // 方法必须挂在 prototype 上（真实宿主形状）：disposer 用 delete 移除自有影子属性后，
  // 只有原型方法才能让调用重新落到原实现；把方法放成自有属性会被 delete 删成 undefined。
  const SERVICE_ID = Symbol('subagents-service-identity')
  const proto = {
    startActivation: async function (spec) {
      startedCalls.push({ spec, self: this })
      return { kind: 'started' }
    },
  }
  if (withGetProvider) {
    proto.getProvider = function (name) {
      if (getProviderThrows) throw new Error('provider registry unavailable')
      return PROVIDERS[name]
    }
  }
  if (withRootOf) {
    // rc.2 的 subagents.rootOf(caller: Agent): Agent（宿主 packages/subagent/subagent/src/index.ts:300）：
    // root 返回自身，其余后代返回其 root。fixture 用显式的 agent.root 指针复刻同一事实。
    proto.rootOf = function (agent) {
      if (agent === undefined || agent === null) throw new TypeError('rootOf 需要一个 Agent')
      return agent.root ?? agent
    }
  }
  const backing = Object.create(proto)
  backing[SERVICE_ID] = true
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
  const services = {
    systemPrompt: { section: () => {} },
    commands: { register: () => {} },
    // 真实 cordis 每次 get 都返回新的 traceable Proxy：用工厂表达，避免「同一 Proxy」假绿。
    subagents: withSubagents ? createProxy() : undefined,
  }
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (name) => services[name],
    on: () => {},
    fiber: { uid: 'test-fiber' },
    settings: { configure: () => () => {} },
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: ctx.fiber ?? { uid: 'test-fiber' },
      settings: ctx.settings ?? { configure: () => () => {} },
      logger: ctx.logger,
    }),
    effect: (factory, label) => {
      const dispose = factory()
      // disposers 只计量「子代理路由包裹」的注销器；设置页策略的注销器另有断言
      // （tests/settings-policy.test.js），不在这里计数，否则会污染既有包裹幂等断言。
      if (label !== 'force-subagent: settings page policy') disposers.push(dispose)
      return dispose
    },
  }
  return {
    ctx,
    warnings,
    disposers,
    subagents: createProxy(),
    backing,
    proto,
    startedCalls,
    SERVICE_ID,
    setGetProviderThrows: (value) => { getProviderThrows = value },
  }
}

/** 团队 root（Lead）：rc.2 下 rootOf(Lead) === Lead，resolveMembership 判为 'lead'。 */
const leadAgent = (session, { id = 'lead-agent', name = 'lead' } = {}) => ({ id, name, session })

/** Lead 直接派下的成员会话：rootOf 返回 Lead，会话头 delegationDepth=1 → 判为 'teammate'。 */
const teammateAgent = (lead, { id = 'member-agent', name = 'impl' } = {}) => ({
  id,
  name,
  root: lead,
  session: { id: `${id}-session`, header: { delegationDepth: 1 }, events: [] },
})

/**
 * rc.2 生产入参形状：扁平 spec，parent / prompt / agentOptions 与 provider / label / signal / delivery
 * 同在顶层；外部调用不传 childId，也没有 request 包装键。
 */
const childSpec = (agent, { provider = 'spawn', childId, agentOptions, name, label = 'impl' } = {}) => ({
  delivery: 'parent',
  ...(childId === undefined ? {} : { childId }),
  provider,
  ...(name === undefined ? {} : { name }),
  label,
  prompt: [{ type: 'text', text: 'do work' }],
  parent: agent,
  ...(agentOptions === undefined ? {} : { agentOptions }),
  signal: new AbortController().signal,
})

/** rc.1 旧形状（parent / agentOptions 包在 spec.request 里）：只用于锁定兼容写回，不是生产形状。 */
const legacySpec = (agent, { provider = 'spawn', childId, agentOptions, name, label = 'impl' } = {}) => ({
  delivery: 'parent',
  ...(childId === undefined ? {} : { childId }),
  provider,
  ...(name === undefined ? {} : { name }),
  label,
  request: { prompt: 'do work', parent: agent, ...(agentOptions === undefined ? {} : { agentOptions }) },
  signal: new AbortController().signal,
})

/** 断言只看转交给原 startActivation 的 spec，不看入参：注入必须发生在转发对象上。 */
const forwarded = (host) => host.startedCalls.at(-1)?.spec

test('a) Lead 直系子级（扁平 spec、无 childId + 门禁开启 + capable）：注入 member 路由到顶层 agentOptions', async () => {
  const host = createHost()
  apply(host.ctx, { member: { ...MEMBER_ROUTE }, subagent: { ...SUBAGENT_ROUTE } })
  const lead = leadAgent(onSession())
  const original = childSpec(lead)
  const { parent, prompt, signal } = original

  const result = await host.subagents.startActivation(original)

  assert.deepEqual(result, { kind: 'started' }, '返回值必须原样透传')
  assert.equal(host.startedCalls.length, 1, '原 startActivation 必须被调用一次')
  const call = host.startedCalls.at(-1)
  assert.equal(call.self?.[host.SERVICE_ID], true, '必须保留 this（宿主按实例调用：this 仍是同一服务对象）')
  const seen = call.spec
  assert.notEqual(seen, original, '必须把新 spec 对象交给原 startActivation（不得就地污染入参）')
  assert.deepEqual(seen.agentOptions, MEMBER_ROUTE, 'rc.2 扁平注入必须落在顶层 agentOptions')
  assert.equal(seen.request, undefined, '不得为扁平 spec 造出 request 包装键')
  assert.equal(seen.parent, parent, 'parent 必须等价透传（同一个 Agent 对象）')
  assert.equal(seen.prompt, prompt, 'prompt 必须等价透传')
  assert.equal(seen.provider, original.provider, '顶层 provider 必须等价透传')
  assert.equal(seen.label, original.label, 'label 必须等价透传')
  assert.equal(seen.delivery, original.delivery, 'delivery 必须等价透传')
  assert.equal(seen.signal, signal, 'signal 必须等价透传')
  assert.equal(original.agentOptions, undefined, '原 spec 不得被写入 agentOptions')
  assert.deepEqual(host.warnings, [], '正常注入不得 warn')
})

test('b) teammate 派下的下级（扁平 spec、无 childId）：门禁沿 root 会话判定，注入 subagent 路由', async () => {
  const host = createHost()
  apply(host.ctx, { member: { ...MEMBER_ROUTE }, subagent: { ...SUBAGENT_ROUTE } })
  const lead = leadAgent(onSession())
  const member = teammateAgent(lead)
  const original = childSpec(member)
  assert.equal(original.childId, undefined)

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.notEqual(seen, original, '注入必须以新 spec 对象转发')
  assert.deepEqual(seen.agentOptions, SUBAGENT_ROUTE, 'teammate 的下级不是成员，必须走 subagent 路由')
  assert.equal(original.agentOptions, undefined, '入参不得被污染')
  assert.deepEqual(host.warnings, [], '成员会话自身没有 /using-agent-team 记录时，门禁必须沿 root 会话判定')
})

test('c) fork 本地 provider（无 childId + provider "fork" capable）：注入默认路由', async () => {
  const host = createHost()
  apply(host.ctx)
  const original = childSpec(leadAgent(onSession()), { provider: 'fork' })

  await host.subagents.startActivation(original)

  assert.deepEqual(forwarded(host).agentOptions, ROUTE)
  assert.equal(original.agentOptions, undefined)
  assert.deepEqual(host.warnings, [])
})

test('d) 调用方显式给了 provider/model/reasoningEffort：严格覆盖为配置路由，删 reasoningEffort，其余字段保留', async () => {
  const host = createHost()
  apply(host.ctx, { member: { ...MEMBER_ROUTE } })
  const requested = { provider: 'openai', model: 'gpt-x', reasoningEffort: 'high', maxTokens: 123 }
  const original = childSpec(leadAgent(onSession()), { provider: 'spawn', agentOptions: requested })

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.deepEqual(
    seen.agentOptions,
    { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model, maxTokens: 123 },
    '必须整体覆盖 provider/model，保留 maxTokens，且不得残留 reasoningEffort',
  )
  assert.equal('reasoningEffort' in seen.agentOptions, false, '转发 spec 不得带 reasoningEffort')
  assert.notEqual(seen.agentOptions, requested, '不得就地改写调用方的 agentOptions 对象')
  assert.deepEqual(original.agentOptions, requested, '入参 agentOptions 不得被污染')
  assert.equal(original.agentOptions.reasoningEffort, 'high', '入参 reasoningEffort 不得被删')
  assert.deepEqual(host.warnings, [])
})

test('e) 外部 provider（acp，capabilities.agentOptions=false）：转发 spec 原样，不注入', async () => {
  const host = createHost()
  apply(host.ctx)
  const originalOptions = { provider: 'acp-inherited', model: 'x', reasoningEffort: 'low' }
  const withOptions = childSpec(leadAgent(onSession()), { provider: 'acp', agentOptions: originalOptions })
  const withoutOptions = childSpec(leadAgent(onSession()), { provider: 'acp' })

  await host.subagents.startActivation(withOptions)
  await host.subagents.startActivation(withoutOptions)

  assert.equal(host.startedCalls.length, 2)
  assert.equal(forwarded(host).agentOptions, undefined, '无 agentOptions 时不得注入')
  const seen = host.startedCalls[0].spec
  assert.equal(seen.agentOptions, originalOptions, '已有 agentOptions 必须原对象转发（不得改写、不得删 reasoningEffort）')
  assert.deepEqual(seen.agentOptions, { provider: 'acp-inherited', model: 'x', reasoningEffort: 'low' })
  assert.deepEqual(host.warnings, [], '外部 provider 不具备能力不是异常，不得 warn')
})

test('f) 会话关闭（无记录 / off / 先 on 后 off）：不注入，转发原 spec', async () => {
  const host = createHost()
  apply(host.ctx)

  for (const events of [[], [runEvent('off')], [runEvent('on'), runEvent('off')]]) {
    const original = childSpec(leadAgent(leadSession(events)))
    await host.subagents.startActivation(original)
    const seen = forwarded(host)
    assert.equal(seen, original, '未命中时必须以原 spec 对象转发')
    assert.equal(seen.agentOptions, undefined, `会话关闭不得注入（events=${JSON.stringify(events)}）`)
    assert.equal(original.agentOptions, undefined)
  }

  assert.equal(host.startedCalls.length, 3)
  assert.deepEqual(host.warnings, [], '会话关闭不是异常，不得 warn')
})

test('g) 会话不可读：fail-open 不抛、原 spec 转发，多次调用只 warn 一次', async () => {
  const host = createHost()
  apply(host.ctx)
  const original = childSpec(leadAgent({}))

  const first = await host.subagents.startActivation(original)
  const second = await host.subagents.startActivation(original)

  assert.deepEqual(first, { kind: 'started' })
  assert.deepEqual(second, { kind: 'started' })
  assert.equal(host.startedCalls.length, 2, 'fail-open 仍必须调用原 startActivation')
  assert.equal(forwarded(host), original, 'fail-open 必须以原 spec 对象转发')
  assert.equal(original.agentOptions, undefined, '读不到会话时不得注入路由')
  assert.equal(host.warnings.length, 1, `多次调用只能 warn 一次，实际 ${host.warnings.length} 次：${JSON.stringify(host.warnings)}`)
  assert.match(host.warnings[0], /^\[force-subagent\] /, 'warn 必须带插件前缀')
  assert.match(host.warnings[0], /子代理模型路由未注入/, 'warn 必须点名后果')
})

test('h) dispose 还原 prototype；重复 apply 不叠加；卸载后再次 apply 重新包裹并注入', async () => {
  const host = createHost()
  apply(host.ctx)
  // 重复 apply：Symbol 守卫跳过包裹，不得再注册 disposer，并按次告警恰好一次。
  apply(host.ctx)

  assert.equal(host.disposers.length, 1, '重复 apply 不得叠加 disposer')
  assert.equal(host.warnings.length, 1, `重复 apply 必须恰好 warn 一次，实际 ${host.warnings.length} 次`)
  assert.match(host.warnings[0], /^\[force-subagent\] /, 'warn 必须带插件前缀')
  assert.match(host.warnings[0], /跳过重复 apply/, 'warn 必须说明跳过原因')

  const first = childSpec(leadAgent(onSession()))
  await host.subagents.startActivation(first)
  assert.equal(host.startedCalls.length, 1, '包裹只能让底层执行一次')
  assert.deepEqual(forwarded(host).agentOptions, ROUTE)

  host.disposers[0]()

  assert.equal(
    Object.prototype.hasOwnProperty.call(host.backing, 'startActivation'),
    false,
    'disposer 必须 delete 本插件写入的自有影子属性',
  )
  assert.equal(host.backing.startActivation, host.proto.startActivation, '删除影子属性后必须恢复 prototype 方法')

  const afterDispose = childSpec(leadAgent(onSession()))
  await host.subagents.startActivation(afterDispose)
  assert.equal(host.startedCalls.length, 2, 'dispose 后调用必须落到原实现（不叠加、不残留包裹）')
  assert.equal(forwarded(host), afterDispose, 'dispose 后必须以原 spec 对象转发，不得再注入')
  assert.equal(afterDispose.agentOptions, undefined)

  // 卸载后二次 apply：原方法无 Symbol 标记，必须重新包裹并注入。
  apply(host.ctx)
  assert.equal(host.disposers.length, 2, '卸载后二次 apply 必须重新注册 disposer')
  const afterReapply = childSpec(leadAgent(onSession()))
  await host.subagents.startActivation(afterReapply)
  assert.deepEqual(forwarded(host).agentOptions, ROUTE, '二次 apply 后必须重新注入')
  assert.equal(afterReapply.agentOptions, undefined)
  assert.equal(host.warnings.length, 1, '卸载后二次 apply 不是重复包裹，不得再 warn')
})

test('i) getProvider 缺失：不注入、不 warn；getProvider 抛错：不注入、不抛、只 warn 一次', async () => {
  const missingHost = createHost({ withGetProvider: false })
  apply(missingHost.ctx)
  const original = childSpec(leadAgent(onSession()))
  await missingHost.subagents.startActivation(original)
  assert.equal(forwarded(missingHost), original, '无 getProvider 必须原 spec 转发')
  assert.equal(original.agentOptions, undefined, '无 getProvider 不得注入')
  assert.deepEqual(missingHost.warnings, [], 'getProvider 缺失不是异常，不得 warn')

  const throwingHost = createHost()
  throwingHost.setGetProviderThrows(true)
  apply(throwingHost.ctx)
  const throwingSpec = childSpec(leadAgent(onSession()))
  const first = await throwingHost.subagents.startActivation(throwingSpec)
  const second = await throwingHost.subagents.startActivation(throwingSpec)
  assert.deepEqual(first, { kind: 'started' }, 'getProvider 抛错不得影响返回值')
  assert.deepEqual(second, { kind: 'started' })
  assert.equal(throwingHost.startedCalls.length, 2, 'fail-open 仍必须调用原 startActivation')
  assert.equal(forwarded(throwingHost).agentOptions, undefined, '抛错时不得注入路由')
  assert.equal(throwingHost.warnings.length, 1, `多次调用只能 warn 一次，实际 ${throwingHost.warnings.length} 次`)
  assert.match(throwingHost.warnings[0], /^\[force-subagent\] /, 'warn 必须带插件前缀')
})

test('j) subagents 缺失：不抛错、不 warn，inject 仍声明 subagents 依赖', () => {
  const host = createHost({ withSubagents: false })
  assert.doesNotThrow(() => apply(host.ctx), 'subagents 缺失不得抛错')
  assert.deepEqual(host.warnings, [], 'subagents 缺失不是异常，不得 warn')
  assert.equal(host.disposers.length, 0, '没有可包裹的方法时不得注册 disposer')
  assert.ok(plugin.inject.includes('subagents'), "inject 必须声明 'subagents' 依赖")
})

// ── 配置化路由：DEFAULT_CONFIG 缺省 / member 与 subagent 双路由 / enabled 透传 / 部分深合并 ──
// 断言逐字比对转发到原 startActivation 的 spec.agentOptions，不做恒真校验。
// 会话统一带 /using-agent-team on：门禁开启是既有前置，差异只可能来自路由配置本身。

test('k) 默认配置（不传 config）：非成员（teammate 的下级）注入 dsh-opencode-go / deepseek-v4.1-flash', async () => {
  const host = createHost()
  apply(host.ctx)
  const original = childSpec(teammateAgent(leadAgent(onSession())))

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.notEqual(seen, original, '注入必须以新 spec 对象转发')
  assert.deepEqual(seen.agentOptions, { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }, '未传 config 时必须落 DEFAULT_CONFIG.subagent')
  assert.equal(original.agentOptions, undefined, '入参 spec 不得被污染')
  assert.deepEqual(host.warnings, [], '正常注入不得 warn')
})

test('l) 双路由：Lead 直系走 member，teammate 的下级走 subagent（rc.2 无 childId 的推断）', async () => {
  const config = { member: { provider: 'pm', model: 'mm' }, subagent: { provider: 'ps', model: 'ms' } }

  const hitHost = createHost()
  apply(hitHost.ctx, config)
  const hit = childSpec(leadAgent(onSession()))
  await hitHost.subagents.startActivation(hit)
  assert.notEqual(forwarded(hitHost), hit, '注入必须以新 spec 对象转发')
  assert.deepEqual(forwarded(hitHost).agentOptions, { provider: 'pm', model: 'mm' }, 'root（Lead）直接派的子级必须走 member 路由')

  const missHost = createHost()
  apply(missHost.ctx, config)
  const miss = childSpec(teammateAgent(leadAgent(onSession())))
  await missHost.subagents.startActivation(miss)
  assert.deepEqual(forwarded(missHost).agentOptions, { provider: 'ps', model: 'ms' }, 'teammate 再派的下级必须走 subagent 路由')

  assert.deepEqual(hitHost.warnings, [], '命中注入不得 warn')
  assert.deepEqual(missHost.warnings, [], '未命中注入不得 warn')
})

test('m) 带 childId 的旧形状判据不变：名册非空但没登记该 childId 时不得误判为成员', async () => {
  const host = createHost()
  apply(host.ctx, { member: { provider: 'pm', model: 'mm' }, subagent: { provider: 'ps', model: 'ms' } })
  // 名册里只有 c1；激活带 childId 'x'：childId 存在本身不是成员判据。
  const original = childSpec(leadAgent(leadSession([runEvent('on'), memberEvent('c1')])), { childId: 'x' })

  await host.subagents.startActivation(original)

  assert.deepEqual(forwarded(host).agentOptions, { provider: 'ps', model: 'ms' }, '名册非空时只认名册命中，未登记不得走 member 路由')
  assert.equal(original.agentOptions, undefined, '入参 spec 不得被污染')
  assert.deepEqual(host.warnings, [])
})

test('m2) 成员身份不可解析（宿主没有 rootOf / tryMembership）：不得放宽成成员，走 subagent 路由', async () => {
  const host = createHost({ withRootOf: false })
  apply(host.ctx, { member: { provider: 'pm', model: 'mm' }, subagent: { provider: 'ps', model: 'ms' } })
  const original = childSpec(leadAgent(onSession()))

  await host.subagents.startActivation(original)

  assert.deepEqual(forwarded(host).agentOptions, { provider: 'ps', model: 'ms' }, '身份判不出来时宁可走 subagent，不得默认当成员')
  assert.equal(original.agentOptions, undefined)
  assert.deepEqual(host.warnings, [], '身份服务缺失不是异常，不得 warn')
})

test('n) enabled=false：完全透传，原 spec 与 agentOptions 原对象转发（含 reasoningEffort）', async () => {
  const host = createHost()
  apply(host.ctx, { enabled: false })
  const requested = { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 1 }
  const original = childSpec(leadAgent(leadSession([runEvent('on'), memberEvent('c1')])), { agentOptions: requested })

  await host.subagents.startActivation(original)

  assert.equal(host.startedCalls.length, 1, '原 startActivation 必须恰好被调用一次')
  assert.equal(forwarded(host), original, 'enabled=false 必须以原 spec 对象转发')
  assert.equal(forwarded(host).agentOptions, requested, 'agentOptions 必须是调用方原对象，不得新建')
  assert.deepEqual(forwarded(host).agentOptions, { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 1 }, '不得覆盖 provider/model、不得删 reasoningEffort')
  assert.deepEqual(host.warnings, [], '关闭开关不是异常，不得 warn')
})

test('o) 部分配置深合并：{subagent:{model:"m2"}} 只改 subagent.model，member 两项都落默认', async () => {
  const host = createHost()
  apply(host.ctx, { subagent: { model: 'm2' } })

  const sub = childSpec(teammateAgent(leadAgent(onSession())))
  await host.subagents.startActivation(sub)
  assert.deepEqual(forwarded(host).agentOptions, { provider: 'dsh-opencode-go', model: 'm2' }, 'subagent 路由：provider 落默认，model 用配置值')

  const mem = childSpec(leadAgent(onSession()))
  await host.subagents.startActivation(mem)
  assert.deepEqual(forwarded(host).agentOptions, { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }, 'member 路由未配置，provider/model 都必须落默认')

  assert.equal(host.startedCalls.length, 2, '两次激活都必须转发到原 startActivation')
  assert.deepEqual(host.warnings, [], '深合并正常注入不得 warn')
})

// ── rc.2 扁平形状回归：生产 0 注入缺陷的回归锁（缺陷形状 = spec.request 恒 undefined → 整块注入不执行） ──

test('F1) 扁平 spec + 门禁开启 + capable + 工作区命中：顶层 agentOptions 必须是工作区配置路由，且不得造出 request 键', async () => {
  const host = createHost()
  apply(host.ctx, { workspaces: { [WORKSPACE_KEY]: { member: { ...MEMBER_ROUTE }, subagent: { ...SUBAGENT_ROUTE } } } })
  const original = childSpec(leadAgent(cwdSession([runEvent('on')])))

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.notEqual(seen, original, '注入必须以新 spec 对象转发')
  assert.deepEqual(seen.agentOptions, MEMBER_ROUTE, '工作区 member 条目必须落到顶层 agentOptions')
  assert.equal(seen.agentOptions.provider, 'minor-5090', 'provider 必须来自配置，不得继承父模型')
  assert.equal(seen.agentOptions.model, 'qwen3.8-flash-next-iq3_xxs', 'model 必须来自配置，不得继承父模型')
  assert.equal('request' in seen, false, '宿主只消费扁平 spec，插件不得新增 request 包装键')
  assert.equal('request' in original, false, '入参 spec 同样不得出现 request 键')
  assert.deepEqual(host.warnings, [], '正常注入不得 warn')
})

test('F2) 扁平 spec + 门禁关闭：agentOptions 不被改写，spec 与 agentOptions 都是原对象', async () => {
  const host = createHost()
  apply(host.ctx, { member: { ...MEMBER_ROUTE } })
  const requested = { provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'high' }
  const original = childSpec(leadAgent(leadSession([runEvent('off')])), { agentOptions: requested })

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.equal(seen, original, '门禁关闭时必须原样转发同一个 spec 对象')
  assert.equal(seen.agentOptions, requested, 'agentOptions 必须是原对象，不得新建、不得改写')
  assert.deepEqual(seen.agentOptions, { provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'high' }, '继承的父路由与推理档位都必须原样保留')
  assert.deepEqual(host.warnings, [], '门禁关闭不是异常，不得 warn')
})

test('F3) 扁平 spec + provider 不具备 agentOptions 能力：不注入、不抛、不 warn（含能力缺失与 provider 未注册）', async () => {
  const host = createHost()
  apply(host.ctx, { member: { ...MEMBER_ROUTE } })
  const lead = leadAgent(onSession())
  const own = { provider: 'inherited', model: 'inherited-model' }

  await host.subagents.startActivation(childSpec(lead, { provider: 'acp', agentOptions: own }))
  assert.equal(forwarded(host).agentOptions, own, 'capabilities.agentOptions=false：必须原对象转发，不得注入')

  await host.subagents.startActivation(childSpec(lead, { provider: 'bare' }))
  assert.equal(forwarded(host).agentOptions, undefined, 'provider 没有 capabilities 字段：不得注入')

  await host.subagents.startActivation(childSpec(lead, { provider: 'not-registered' }))
  assert.equal(forwarded(host).agentOptions, undefined, 'provider 未注册（getProvider 返回 undefined）：不得注入')

  assert.equal(host.startedCalls.length, 3, '三种不注入都必须照常调用原 startActivation')
  assert.deepEqual(host.warnings, [], 'provider 能力不足不是异常，不得 warn')
})

test('F4) 入参 spec 不被就地修改：宿主收到的是新对象，入参字段与 agentOptions 原值不变', async () => {
  const host = createHost()
  apply(host.ctx, { member: { ...MEMBER_ROUTE } })
  const requested = { provider: 'openai', model: 'gpt-x', reasoningEffort: 'medium' }
  const original = childSpec(leadAgent(onSession()), { agentOptions: requested })
  const before = { ...original }

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.notEqual(seen, original, '宿主必须收到新对象')
  assert.equal(original.agentOptions, requested, '入参 agentOptions 必须仍是调用方原对象')
  assert.deepEqual(original.agentOptions, { provider: 'openai', model: 'gpt-x', reasoningEffort: 'medium' }, '入参 agentOptions 的 provider/model/reasoningEffort 都不得被改写')
  assert.deepEqual({ ...original }, before, '入参 spec 的每个键都必须保持原值（含 provider / label / delivery / signal / parent / prompt）')
  assert.equal(original.signal, before.signal, 'signal 必须是同一个 AbortSignal')
  assert.equal(original.parent, before.parent, 'parent 必须是同一个 Agent')
  assert.deepEqual(seen.agentOptions, { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model }, '转发对象必须换成配置路由，且键集只有 provider / model')
  assert.equal('reasoningEffort' in seen.agentOptions, false, '转发对象不得残留 reasoningEffort')
})

test('F5) 嵌套形状兼容写回（rc.1 / 旧测试形状）：顶层与 request 包装同时更新，入参包装不被污染', async () => {
  const host = createHost()
  apply(host.ctx, { member: { ...MEMBER_ROUTE } })
  const requested = { provider: 'openai', model: 'gpt-x', maxTokens: 7 }
  const original = legacySpec(leadAgent(onSession()), { agentOptions: requested })

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.notEqual(seen, original, '注入必须以新 spec 对象转发')
  assert.deepEqual(seen.agentOptions, { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model, maxTokens: 7 }, '宿主消费的顶层 agentOptions 必须已注入')
  assert.deepEqual(seen.request.agentOptions, { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model, maxTokens: 7 }, 'rc.1 包装内也必须同步更新')
  assert.notEqual(seen.request, original.request, '不得就地改写入参 request 对象')
  assert.notEqual(seen.request.agentOptions, requested, '不得就地改写调用方的 agentOptions 对象')
  assert.deepEqual(original.request.agentOptions, requested, '入参 request.agentOptions 必须保持原值')
  assert.equal(original.agentOptions, undefined, '入参 spec 不得被写入顶层 agentOptions')
  assert.deepEqual(host.warnings, [], '正常注入不得 warn')
})

// ── reviewer（审查代码模型）注入：三态优先级链 + 扁平 / 嵌套两种落点 ──────────────
// 契约：reviewer 激活的注入链是「工作区 reviewer > 全局 reviewer > 该激活本来的 member / subagent 路由」；
// 两级都没配时行为必须与引入 reviewer 之前完全一致。

const REVIEWER_GLOBAL = { provider: 'review-global-p', model: 'review-global-m' }
const REVIEWER_SCOPED = { provider: 'review-ws-p', model: 'review-ws-m' }

test('RF1) 扁平 reviewer 激活 + 工作区 reviewer 已配：顶层 agentOptions 必须是工作区 reviewer，reasoningEffort 照旧删除', async () => {
  const host = createHost()
  apply(host.ctx, {
    reviewer: { ...REVIEWER_GLOBAL },
    workspaces: { [WORKSPACE_KEY]: { reviewer: { ...REVIEWER_SCOPED }, member: { ...MEMBER_ROUTE }, subagent: { ...SUBAGENT_ROUTE } } },
  })
  const callerOptions = { reasoningEffort: 'high', temperature: 0.2 }
  const original = childSpec(leadAgent(cwdSession([runEvent('on')])), { name: 'reviewer', label: 'review impl', agentOptions: callerOptions })

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.notEqual(seen, original, '注入必须以新 spec 对象转发')
  assert.deepEqual(
    seen.agentOptions,
    { provider: REVIEWER_SCOPED.provider, model: REVIEWER_SCOPED.model, temperature: 0.2 },
    '工作区 reviewer 必须优先于全局 reviewer 与 member 路由，且只清 reasoningEffort',
  )
  assert.equal(seen.agentOptions.reasoningEffort, undefined, '显式给了 reasoningEffort 也必须删')
  assert.equal('request' in seen, false, '扁平 spec 不得造出 request 包装键')
  assert.deepEqual(original.agentOptions, callerOptions, '入参 agentOptions 必须保持原值')
  assert.notEqual(seen.agentOptions, callerOptions, '不得就地改写调用方的 agentOptions 对象')
  assert.equal(seen.name, 'reviewer', 'name 必须原样透传给宿主')
  assert.deepEqual(host.warnings, [], `正常 reviewer 注入不得 warn，实际：${JSON.stringify(host.warnings)}`)
})

test('RF2) 扁平 reviewer 激活 + 只有全局 reviewer：落全局 reviewer，而不是该工作区的 member / subagent', async () => {
  const host = createHost()
  apply(host.ctx, {
    reviewer: { ...REVIEWER_GLOBAL },
    workspaces: { [WORKSPACE_KEY]: { member: { ...MEMBER_ROUTE }, subagent: { ...SUBAGENT_ROUTE } } },
  })
  const original = childSpec(leadAgent(cwdSession([runEvent('on')])), { name: 'code-reviewer', label: 'review impl' })

  await host.subagents.startActivation(original)

  assert.deepEqual(
    forwarded(host).agentOptions,
    { provider: REVIEWER_GLOBAL.provider, model: REVIEWER_GLOBAL.model },
    '工作区没配 reviewer 时必须回退全局 reviewer，而不是工作区 member',
  )
  assert.deepEqual(host.warnings, [], `正常 reviewer 注入不得 warn，实际：${JSON.stringify(host.warnings)}`)
})

test('RF3) 扁平 reviewer 激活 + 两级 reviewer 都没配：Lead 直系仍落 member、teammate 下级仍落 subagent（与引入 reviewer 前一致）', async () => {
  const host = createHost()
  apply(host.ctx, { workspaces: { [WORKSPACE_KEY]: { member: { ...MEMBER_ROUTE }, subagent: { ...SUBAGENT_ROUTE } } } })
  const lead = leadAgent(cwdSession([runEvent('on')]))

  await host.subagents.startActivation(childSpec(lead, { name: 'reviewer', label: 'review impl' }))
  assert.deepEqual(
    forwarded(host).agentOptions,
    { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model },
    '没配 reviewer 时成员就是成员：不得因为名字是 reviewer 就落默认路由或造出 reviewer 路由',
  )

  await host.subagents.startActivation(childSpec(teammateAgent(lead), { name: 'adversarial-reviewer', label: 'review impl' }))
  assert.deepEqual(
    forwarded(host).agentOptions,
    { provider: SUBAGENT_ROUTE.provider, model: SUBAGENT_ROUTE.model },
    'teammate 派下的审查代码激活同样回退它本来的 subagent 路由',
  )
  assert.deepEqual(host.warnings, [], `未配置 reviewer 不得产生任何 warn，实际：${JSON.stringify(host.warnings)}`)
})

test('RF4) 嵌套形状（rc.1 包装）的 reviewer 激活：顶层与 request 包装同时写入 reviewer 路由，入参不被污染', async () => {
  const host = createHost()
  apply(host.ctx, { reviewer: { ...REVIEWER_GLOBAL }, workspaces: { [WORKSPACE_KEY]: { reviewer: { ...REVIEWER_SCOPED } } } })
  const callerOptions = { reasoningEffort: 'low', maxTokens: 7 }
  const original = legacySpec(leadAgent(cwdSession([runEvent('on')])), { name: 'reviewer', label: 'review impl', agentOptions: callerOptions })

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  const expected = { provider: REVIEWER_SCOPED.provider, model: REVIEWER_SCOPED.model, maxTokens: 7 }
  assert.deepEqual(seen.agentOptions, expected, '宿主消费的顶层 agentOptions 必须是工作区 reviewer')
  assert.deepEqual(seen.request.agentOptions, expected, '嵌套形状必须同步写 request.agentOptions')
  assert.notEqual(seen.request, original.request, '不得就地改写入参 request 对象')
  assert.notEqual(seen.request.agentOptions, callerOptions, '不得就地改写调用方的 agentOptions 对象')
  assert.deepEqual(original.request.agentOptions, callerOptions, '入参 request.agentOptions 必须保持原值')
  assert.equal(original.agentOptions, undefined, '入参 spec 不得被写入顶层 agentOptions')
  assert.equal(seen.agentOptions.reasoningEffort, undefined, 'reasoningEffort 必须删除')
})

test('RF5) reviewer 配置存在也不能抢走实现类激活：name 非实现审查名字时落 member / subagent', async () => {
  const host = createHost()
  apply(host.ctx, { reviewer: { ...REVIEWER_GLOBAL }, workspaces: { [WORKSPACE_KEY]: { member: { ...MEMBER_ROUTE }, subagent: { ...SUBAGENT_ROUTE } } } })
  const lead = leadAgent(cwdSession([runEvent('on')]))

  await host.subagents.startActivation(childSpec(lead, { name: 'coder', label: '实现审查代码模型' }))
  assert.deepEqual(
    forwarded(host).agentOptions,
    { provider: MEMBER_ROUTE.provider, model: MEMBER_ROUTE.model },
    'label 里有「审查代码」不算审查任务：成员仍走 member 路由',
  )

  await host.subagents.startActivation(childSpec(teammateAgent(lead), { label: '修复代码审查bug' }))
  assert.deepEqual(
    forwarded(host).agentOptions,
    { provider: SUBAGENT_ROUTE.provider, model: SUBAGENT_ROUTE.model },
    '未命名激活的 label 不是明确审查意图时同样落 subagent 路由',
  )
  assert.deepEqual(host.warnings, [], `不得 warn，实际：${JSON.stringify(host.warnings)}`)
})
