/**
 * dsh-force-subagent 子代理模型路由注入测试。
 *
 * 契约：apply() 用 ctx.effect 包裹 ctx.get('subagents').startActivation。
 * 命中条件只有两个：父会话 /using-agent-team 已开启，且 spec.provider 对应的 provider 经公开访问器
 * `subagents.getProvider(name)` 查到且 `capabilities.agentOptions === true`。childId 不再是判别条件
 * （teammate / 普通 subagent / fork / workflow 的本地 in-process 路径一律适用）。
 * 命中时严格覆盖 provider/model 并删除 reasoningEffort，其余 agentOptions 字段保留；
 * 入参 spec 不被就地改写，其余 spec 字段、返回值、异常语义原样透传。
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

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const leadSession = (events) => ({ events })
const onSession = () => leadSession([runEvent('on')])

/** provider 注册表的真实形状：capabilities.agentOptions 才是「能不能收子代理 agentOptions」的判据。 */
const PROVIDERS = {
  spawn: { name: 'spawn', capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true } },
  fork: { name: 'fork', capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true } },
  acp: { name: 'acp', capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false } },
}

/** 插件的边界只有两个：ctx（宿主上下文）与 session（会话事件来源），其余都是真实实现。 */
function createHost({ withSubagents = true, withGetProvider = true } = {}) {
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

/** startActivation 的入参形状（teammate 传 childId，普通 subagent / fork / workflow 不传）。 */
const childSpec = (session, { provider = 'spawn', request = {}, childId } = {}) => ({
  delivery: 'parent',
  ...(childId === undefined ? {} : { childId }),
  provider,
  label: 'impl',
  request: { prompt: 'do work', parent: { session }, ...request },
  signal: new AbortController().signal,
})

/** 断言只看转交给原 startActivation 的 spec，不看入参：注入必须发生在转发对象上。 */
const forwarded = (host) => host.startedCalls.at(-1)?.spec

test('a) teammate（childId + 会话开启 + capable）：转发 spec 为默认路由，原 spec 不被污染', async () => {
  const host = createHost()
  apply(host.ctx)
  const original = childSpec(onSession(), { childId: 'child-1' })
  const parent = original.request.parent

  const result = await host.subagents.startActivation(original)

  assert.deepEqual(result, { kind: 'started' }, '返回值必须原样透传')
  assert.equal(host.startedCalls.length, 1, '原 startActivation 必须被调用一次')
  const call = host.startedCalls.at(-1)
  assert.equal(call.self?.[host.SERVICE_ID], true, '必须保留 this（宿主按实例调用：this 仍是同一服务对象）')
  const seen = call.spec
  assert.notEqual(seen, original, '必须把新 spec 对象交给原 startActivation（不得就地污染入参）')
  assert.deepEqual(seen.request.agentOptions, ROUTE, '转发 spec 的 agentOptions 必须是默认路由')
  assert.deepEqual(Object.keys(original.request).sort(), ['parent', 'prompt'], '原 spec.request 字段不得变化')
  assert.equal(original.request.agentOptions, undefined, '原 spec.request 不得被写入 agentOptions')
  assert.equal(seen.request.parent, parent, 'request.parent 必须等价透传')
  assert.equal(seen.request.prompt, 'do work', 'request.prompt 必须等价透传')
  assert.equal(seen.childId, 'child-1', 'childId 必须等价透传')
  assert.equal(seen.provider, original.provider, '顶层 provider 必须等价透传')
  assert.equal(seen.signal, original.signal, 'signal 必须等价透传')
  assert.deepEqual(host.warnings, [], '正常注入不得 warn')
})

test('b) 普通 subagent（无 childId + 会话开启 + capable）：同样注入默认子代理路由（新语义）', async () => {
  const host = createHost()
  apply(host.ctx)
  const original = childSpec(onSession(), { provider: 'spawn' })
  assert.equal(original.childId, undefined)

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.deepEqual(seen.request.agentOptions, ROUTE, '无 childId 不得再被放行：capability 才是判据')
  assert.equal(original.request.agentOptions, undefined, '入参不得被污染')
  assert.deepEqual(host.warnings, [])
})

test('c) fork 本地 provider（childId 缺省 + provider "fork" capable）：注入默认路由', async () => {
  const host = createHost()
  apply(host.ctx)
  const original = childSpec(onSession(), { provider: 'fork' })

  await host.subagents.startActivation(original)

  assert.deepEqual(forwarded(host).request.agentOptions, ROUTE)
  assert.equal(original.request.agentOptions, undefined)
  assert.deepEqual(host.warnings, [])
})

test('d) 显式 provider/model/reasoningEffort：严格覆盖为默认路由，删除 reasoningEffort，其余字段保留', async () => {
  const host = createHost()
  apply(host.ctx)
  const requested = { provider: 'openai', model: 'gpt-x', reasoningEffort: 'high', maxTokens: 123 }
  const original = childSpec(onSession(), { provider: 'spawn', request: { agentOptions: requested } })

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.deepEqual(
    seen.request.agentOptions,
    { provider: ROUTE.provider, model: ROUTE.model, maxTokens: 123 },
    '必须整体覆盖 provider/model，保留 maxTokens，且不得残留 reasoningEffort',
  )
  assert.equal('reasoningEffort' in seen.request.agentOptions, false, '转发 spec 不得带 reasoningEffort')
  assert.notEqual(seen.request.agentOptions, requested, '不得就地改写调用方的 agentOptions 对象')
  assert.deepEqual(original.request.agentOptions, requested, '入参 agentOptions 不得被污染')
  assert.equal(original.request.agentOptions.reasoningEffort, 'high', '入参 reasoningEffort 不得被删')
  assert.deepEqual(host.warnings, [])
})

test('e) 外部 provider（acp，capabilities.agentOptions=false）：转发 spec 原样，不注入', async () => {
  const host = createHost()
  apply(host.ctx)
  const originalOptions = { provider: 'acp-inherited', model: 'x', reasoningEffort: 'low' }
  const withOptions = childSpec(onSession(), { provider: 'acp', request: { agentOptions: originalOptions } })
  const withoutOptions = childSpec(onSession(), { provider: 'acp' })

  await host.subagents.startActivation(withOptions)
  await host.subagents.startActivation(withoutOptions)

  assert.equal(host.startedCalls.length, 2)
  assert.equal(forwarded(host).request.agentOptions, undefined, '无 agentOptions 时不得注入')
  const seen = host.startedCalls[0].spec
  assert.equal(seen.request.agentOptions, originalOptions, '已有 agentOptions 必须原对象转发（不得改写、不得删 reasoningEffort）')
  assert.deepEqual(seen.request.agentOptions, { provider: 'acp-inherited', model: 'x', reasoningEffort: 'low' })
  assert.deepEqual(host.warnings, [], '外部 provider 不具备能力不是异常，不得 warn')
})

test('f) 会话关闭（无记录 / off / 先 on 后 off）：不注入，转发原 spec', async () => {
  const host = createHost()
  apply(host.ctx)

  for (const events of [[], [runEvent('off')], [runEvent('on'), runEvent('off')]]) {
    const original = childSpec(leadSession(events), { childId: 'child-1' })
    await host.subagents.startActivation(original)
    const seen = forwarded(host)
    assert.equal(seen, original, '未命中时必须以原 spec 对象转发')
    assert.equal(seen.request.agentOptions, undefined, `会话关闭不得注入（events=${JSON.stringify(events)}）`)
    assert.equal(original.request.agentOptions, undefined)
  }

  assert.equal(host.startedCalls.length, 3)
  assert.deepEqual(host.warnings, [], '会话关闭不是异常，不得 warn')
})

test('g) 会话不可读：fail-open 不抛、原 spec 转发，多次调用只 warn 一次', async () => {
  const host = createHost()
  apply(host.ctx)
  const original = childSpec({}, { childId: 'child-1' })

  const first = await host.subagents.startActivation(original)
  const second = await host.subagents.startActivation(original)

  assert.deepEqual(first, { kind: 'started' })
  assert.deepEqual(second, { kind: 'started' })
  assert.equal(host.startedCalls.length, 2, 'fail-open 仍必须调用原 startActivation')
  assert.equal(forwarded(host), original, 'fail-open 必须以原 spec 对象转发')
  assert.equal(original.request.agentOptions, undefined, '读不到会话时不得注入路由')
  assert.equal(host.warnings.length, 1, `多次调用只能 warn 一次，实际 ${host.warnings.length} 次：${JSON.stringify(host.warnings)}`)
  assert.match(host.warnings[0], /^\[force-subagent\] /, 'warn 必须带插件前缀')
  assert.match(host.warnings[0], /子代理模型路由未注入/, 'warn 必须点名后果')
})

test('h) dispose 还原 prototype；重复 apply 不叠加；卸载后再次 apply 重新包裹并注入', async () => {
  const host = createHost()
  apply(host.ctx)
  // 重复 apply：Symbol 守卫跳过包裹，不得再注册 disposer，并按次 warn 恰好一次。
  apply(host.ctx)

  assert.equal(host.disposers.length, 1, '重复 apply 不得叠加 disposer')
  assert.equal(host.warnings.length, 1, `重复 apply 必须恰好 warn 一次，实际 ${host.warnings.length} 次`)
  assert.match(host.warnings[0], /^\[force-subagent\] /, 'warn 必须带插件前缀')
  assert.match(host.warnings[0], /跳过重复 apply/, 'warn 必须说明跳过原因')

  const original = childSpec(onSession(), { childId: 'child-1' })
  await host.subagents.startActivation(original)
  assert.equal(host.startedCalls.length, 1, '包裹只能让底层执行一次')
  assert.deepEqual(forwarded(host).request.agentOptions, ROUTE)

  host.disposers[0]()

  assert.equal(
    Object.prototype.hasOwnProperty.call(host.backing, 'startActivation'),
    false,
    'disposer 必须 delete 本插件写入的自有影子属性',
  )
  assert.equal(host.backing.startActivation, host.proto.startActivation, '删除影子属性后必须恢复 prototype 方法')

  const afterDispose = childSpec(onSession(), { childId: 'child-1' })
  await host.subagents.startActivation(afterDispose)
  assert.equal(host.startedCalls.length, 2, 'dispose 后调用必须落到原实现（不叠加、不残留包裹）')
  assert.equal(forwarded(host), afterDispose, 'dispose 后必须以原 spec 对象转发，不得再注入')
  assert.equal(afterDispose.request.agentOptions, undefined)

  // 卸载后二次 apply：原方法无 Symbol 标记，必须重新包裹并注入。
  apply(host.ctx)
  assert.equal(host.disposers.length, 2, '卸载后二次 apply 必须重新注册 disposer')
  const afterReapply = childSpec(onSession(), { childId: 'child-1' })
  await host.subagents.startActivation(afterReapply)
  assert.deepEqual(forwarded(host).request.agentOptions, ROUTE, '二次 apply 后必须重新注入')
  assert.equal(afterReapply.request.agentOptions, undefined)
  assert.equal(host.warnings.length, 1, '卸载后二次 apply 不是重复包裹，不得再 warn')
})

test('i) getProvider 缺失：不注入、不 warn；getProvider 抛错：不注入、不抛、只 warn 一次', async () => {
  const missingHost = createHost({ withGetProvider: false })
  apply(missingHost.ctx)
  const original = childSpec(onSession(), { childId: 'child-1' })
  await missingHost.subagents.startActivation(original)
  assert.equal(forwarded(missingHost), original, '无 getProvider 必须原 spec 转发')
  assert.equal(original.request.agentOptions, undefined, '无 getProvider 不得注入')
  assert.deepEqual(missingHost.warnings, [], 'getProvider 缺失不是异常，不得 warn')

  const throwingHost = createHost()
  throwingHost.setGetProviderThrows(true)
  apply(throwingHost.ctx)
  const throwingSpec = childSpec(onSession(), { childId: 'child-2' })
  const first = await throwingHost.subagents.startActivation(throwingSpec)
  const second = await throwingHost.subagents.startActivation(throwingSpec)
  assert.deepEqual(first, { kind: 'started' }, 'getProvider 抛错不得影响返回值')
  assert.deepEqual(second, { kind: 'started' })
  assert.equal(throwingHost.startedCalls.length, 2, 'fail-open 仍必须调用原 startActivation')
  assert.equal(forwarded(throwingHost).request.agentOptions, undefined, '抛错时不得注入路由')
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
// 断言逐字比对转发到原 startActivation 的 spec.request.agentOptions，不做恒真校验。
// 会话统一带 /using-agent-team on：门禁开启是既有前置，差异只可能来自路由配置本身。

test('k) 默认配置（不传 config）：非成员激活注入 dsh-opencode-go / deepseek-v4.1-flash', async () => {
  const host = createHost()
  apply(host.ctx)
  const original = childSpec(onSession(), { childId: 'not-registered' })

  await host.subagents.startActivation(original)

  const seen = forwarded(host)
  assert.notEqual(seen, original, '注入必须以新 spec 对象转发')
  assert.deepEqual(seen.request.agentOptions, { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }, '未传 config 时必须落 DEFAULT_CONFIG.subagent')
  assert.equal(original.request.agentOptions, undefined, '入参 spec 不得被污染')
  assert.deepEqual(host.warnings, [], '正常注入不得 warn')
})

test('l) 双路由：childId 命中 team/member 走 member 路由，未命中走 subagent 路由', async () => {
  const config = { member: { provider: 'pm', model: 'mm' }, subagent: { provider: 'ps', model: 'ms' } }

  const hitHost = createHost()
  apply(hitHost.ctx, config)
  const hit = childSpec(leadSession([runEvent('on'), { type: 'team/member', data: { member: { id: 'c1' } } }]), { childId: 'c1' })
  await hitHost.subagents.startActivation(hit)
  assert.notEqual(forwarded(hitHost), hit, '注入必须以新 spec 对象转发')
  assert.deepEqual(forwarded(hitHost).request.agentOptions, { provider: 'pm', model: 'mm' }, 'team/member 登记的 childId 必须走 member 路由')

  const missHost = createHost()
  apply(missHost.ctx, config)
  const miss = childSpec(leadSession([runEvent('on'), { type: 'team/member', data: { member: { id: 'c1' } } }]), { childId: 'c2' })
  await missHost.subagents.startActivation(miss)
  assert.deepEqual(forwarded(missHost).request.agentOptions, { provider: 'ps', model: 'ms' }, '会话只登记了 c1，激活 c2 必须走 subagent 路由')

  assert.deepEqual(hitHost.warnings, [], '命中注入不得 warn')
  assert.deepEqual(missHost.warnings, [], '未命中注入不得 warn')
})

test('m) 非成员带 childId：会话无 team/member 事件时不得误判为成员', async () => {
  const host = createHost()
  apply(host.ctx, { member: { provider: 'pm', model: 'mm' }, subagent: { provider: 'ps', model: 'ms' } })
  const original = childSpec(onSession(), { childId: 'x' })

  await host.subagents.startActivation(original)

  assert.deepEqual(forwarded(host).request.agentOptions, { provider: 'ps', model: 'ms' }, 'childId 存在本身不是成员判据，必须走 subagent 路由')
  assert.equal(original.request.agentOptions, undefined, '入参 spec 不得被污染')
  assert.deepEqual(host.warnings, [])
})

test('n) enabled=false：完全透传，原 spec 与 agentOptions 原对象转发（含 reasoningEffort）', async () => {
  const host = createHost()
  apply(host.ctx, { enabled: false })
  const requested = { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 1 }
  const original = childSpec(leadSession([runEvent('on'), { type: 'team/member', data: { member: { id: 'c1' } } }]), { childId: 'c1', request: { agentOptions: requested } })

  await host.subagents.startActivation(original)

  assert.equal(host.startedCalls.length, 1, '原 startActivation 必须恰好被调用一次')
  assert.equal(forwarded(host), original, 'enabled=false 必须以原 spec 对象转发')
  assert.equal(forwarded(host).request.agentOptions, requested, 'agentOptions 必须是调用方原对象，不得新建')
  assert.deepEqual(forwarded(host).request.agentOptions, { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 1 }, '不得覆盖 provider/model、不得删 reasoningEffort')
  assert.deepEqual(host.warnings, [], '关闭开关不是异常，不得 warn')
})

test('o) 部分配置深合并：{subagent:{model:"m2"}} 只改 subagent.model，member 两项都落默认', async () => {
  const host = createHost()
  apply(host.ctx, { subagent: { model: 'm2' } })

  const sub = childSpec(onSession(), { childId: 'x' })
  await host.subagents.startActivation(sub)
  assert.deepEqual(forwarded(host).request.agentOptions, { provider: 'dsh-opencode-go', model: 'm2' }, 'subagent 路由：provider 落默认，model 用配置值')

  const mem = childSpec(leadSession([runEvent('on'), { type: 'team/member', data: { member: { id: 'c1' } } }]), { childId: 'c1' })
  await host.subagents.startActivation(mem)
  assert.deepEqual(forwarded(host).request.agentOptions, { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }, 'member 路由未配置，provider/model 都必须落默认')

  assert.equal(host.startedCalls.length, 2, '两次激活都必须转发到原 startActivation')
  assert.deepEqual(host.warnings, [], '深合并正常注入不得 warn')
})
