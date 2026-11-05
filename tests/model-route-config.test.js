/**
 * 模型路由配置测试：resolveConfig 深合并与回退、成员/子代理路由分流、enabled 透传。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply, resolveConfig, memberIds, DEFAULT_CONFIG, DEFAULT_ROUTE } = plugin

const COMMAND_NAME = 'using-agent-team'

/** 开启 Agent-Team 的 command/run 事件（parseCommandInput('') 解析为 enabled: true）。 */
const enableEvent = () => ({ type: 'command/run', data: { name: COMMAND_NAME, args: '' } })
/** agent-team 在 startActivation 之前写入的成员登记事件；member.id 就是 childId。 */
const memberEvent = (id) => ({ type: 'team/member', data: { version: 2, teamId: 'team-1', member: { id } } })
/** 真实结构：request.parent 是 Agent，其 .session 才暴露 events（与 index.js 既有 commandState 用法一致）。 */
const sessionWith = (...events) => ({ events: [enableEvent(), ...events] })

function createSubagents({ agentOptions = true } = {}) {
  const calls = []
  return {
    calls,
    startActivation(spec) {
      calls.push(spec)
      return { ok: true }
    },
    getProvider: () => ({ capabilities: { agentOptions } }),
  }
}

function createHost(subagents, warnings) {
  const disposers = []
  const ctx = {
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: ctx.fiber ?? { uid: 'test-fiber' },
      settings: ctx.settings ?? { configure: () => () => {} },
      logger: ctx.logger,
    }),
    logger: { warn: (message) => warnings.push(message) },
    get: (service) => (service === 'subagents' ? subagents : undefined),
    on: () => {},
    effect: (fn) => { disposers.push(fn()) },
  }
  return { ctx, disposers }
}

function install(config, options) {
  const subagents = createSubagents(options)
  const warnings = []
  const host = createHost(subagents, warnings)
  apply(host.ctx, config)
  return { subagents, warnings, ctx: host.ctx, disposers: host.disposers }
}

test('默认路由不回归：与历史硬编码一致', () => {
  assert.deepEqual(DEFAULT_ROUTE, { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(DEFAULT_CONFIG, {
    enabled: true,
    mode: 'nested',
    member: { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' },
    subagent: { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' },
    workspaces: {},
  })
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG)
})

test('空配置时成员与子代理都走默认路由', () => {
  const { subagents } = install(undefined)
  subagents.startActivation({
    childId: 'child-a',
    provider: 'p-origin',
    request: { parent: { session: sessionWith(memberEvent('child-a')) }, agentOptions: {} },
  })
  assert.equal(subagents.calls.length, 1)
  assert.equal(subagents.calls[0].request.agentOptions.provider, DEFAULT_ROUTE.provider)
  assert.equal(subagents.calls[0].request.agentOptions.model, DEFAULT_ROUTE.model)
})

test('成员 childId 走 member 路由，其余 agentOptions 原样透传', () => {
  const config = { member: { provider: 'p-member', model: 'm-member' }, subagent: { provider: 'p-sub', model: 'm-sub' } }
  const { subagents } = install(config)
  const spec = {
    childId: 'child-a',
    provider: 'p-origin',
    request: { parent: { session: sessionWith(memberEvent('child-a')) }, agentOptions: { maxTokens: 64, reasoningEffort: 'high' } },
  }
  subagents.startActivation(spec)

  const sent = subagents.calls[0]
  assert.equal(sent.request.agentOptions.provider, 'p-member')
  assert.equal(sent.request.agentOptions.model, 'm-member')
  assert.equal(sent.request.agentOptions.maxTokens, 64)
  assert.equal('reasoningEffort' in sent.request.agentOptions, false)
  assert.equal('provider' in spec.request.agentOptions, false, '入参 spec 不得被就地改写')
})

test('非成员带 childId 不误判：走 subagent 路由', () => {
  const config = { member: { provider: 'p-member', model: 'm-member' }, subagent: { provider: 'p-sub', model: 'm-sub' } }
  const { subagents } = install(config)
  subagents.startActivation({
    childId: 'stranger',
    provider: 'p-origin',
    request: { parent: { session: sessionWith(memberEvent('child-a')) }, agentOptions: {} },
  })
  assert.equal(subagents.calls[0].request.agentOptions.provider, 'p-sub')
  assert.equal(subagents.calls[0].request.agentOptions.model, 'm-sub')
})

test('无 childId 的普通 subagent 走 subagent 路由', () => {
  const config = { member: { provider: 'p-member', model: 'm-member' }, subagent: { provider: 'p-sub', model: 'm-sub' } }
  const { subagents } = install(config)
  subagents.startActivation({
    provider: 'p-origin',
    request: { parent: { session: sessionWith(memberEvent('child-a')) }, agentOptions: {} },
  })
  assert.equal(subagents.calls[0].request.agentOptions.provider, 'p-sub')
})

test('enabled=false 完全透传：原 spec 对象转发、reasoningEffort 保留', () => {
  const { subagents } = install({ enabled: false, member: { provider: 'p-member', model: 'm-member' } })
  const spec = {
    childId: 'child-a',
    provider: 'p-origin',
    request: { parent: { session: sessionWith(memberEvent('child-a')) }, agentOptions: { reasoningEffort: 'high', maxTokens: 8 } },
  }
  subagents.startActivation(spec)

  assert.equal(subagents.calls[0], spec, '必须原对象转发，不得复制或改写')
  assert.equal(subagents.calls[0].request.agentOptions.reasoningEffort, 'high')
  assert.equal(subagents.calls[0].request.agentOptions.maxTokens, 8)
  assert.equal('provider' in subagents.calls[0].request.agentOptions, false)
})

test('部分配置深合并：缺省字段各自回退', () => {
  const value = resolveConfig({ member: { provider: 'p-member' }, subagent: { model: 'm-sub' } })
  assert.equal(value.member.provider, 'p-member')
  assert.equal(value.member.model, DEFAULT_ROUTE.model)
  assert.equal(value.subagent.provider, DEFAULT_ROUTE.provider)
  assert.equal(value.subagent.model, 'm-sub')
  assert.equal(value.enabled, true)
})

test('非法配置回退默认且不抛', () => {
  assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig({ enabled: 'yes', member: 42, subagent: [] }), DEFAULT_CONFIG)
  assert.equal(resolveConfig({ member: { provider: '', model: 7 } }).member.provider, DEFAULT_ROUTE.provider)
  assert.equal(resolveConfig({ member: { provider: '', model: 7 } }).member.model, DEFAULT_ROUTE.model)
})

test('memberIds 只认 team/member 事件的 member.id', () => {
  const ids = memberIds({
    events: [
      memberEvent('child-a'),
      { type: 'other', data: { member: { id: 'ignored' } } },
      { type: 'team/member', data: { member: { name: 'no-id' } } },
      memberEvent('child-b'),
    ],
  })
  assert.deepEqual([...ids].sort(), ['child-a', 'child-b'])
  assert.equal(memberIds({}).size, 0)
  assert.equal(memberIds(undefined).size, 0)
  assert.equal(memberIds({ snapshotEvents: () => [memberEvent('child-c')] }).has('child-c'), true)
})

test('会话未开启 /using-agent-team 时不注入路由', () => {
  const { subagents } = install({ member: { provider: 'p-member', model: 'm-member' } })
  subagents.startActivation({
    childId: 'child-a',
    provider: 'p-origin',
    request: { parent: { session: { events: [] } }, agentOptions: { reasoningEffort: 'keep' } },
  })
  assert.equal('provider' in subagents.calls[0].request.agentOptions, false)
  assert.equal(subagents.calls[0].request.agentOptions.reasoningEffort, 'keep')
})

test('provider 未声明 agentOptions 能力时不注入', () => {
  const { subagents } = install({}, { agentOptions: false })
  subagents.startActivation({
    childId: 'child-a',
    provider: 'p-origin',
    request: { parent: { session: sessionWith(memberEvent('child-a')) }, agentOptions: { reasoningEffort: 'keep' } },
  })
  assert.equal('provider' in subagents.calls[0].request.agentOptions, false)
  assert.equal(subagents.calls[0].request.agentOptions.reasoningEffort, 'keep')
})

test('重复 apply 不叠加包裹', () => {
  const subagents = createSubagents()
  const warnings = []
  const host = createHost(subagents, warnings)
  apply(host.ctx, {})
  apply(host.ctx, {})
  assert.equal(
    warnings.some((message) => String(message).includes('包裹已安装')),
    true,
    '第二次 apply 应命中已包裹分支并告警',
  )
})

test('开启态但父会话无任何 team/member 事件：带 childId 也必须走 subagent 路由', () => {
  const { subagents } = install({
    member: { provider: 'p-member', model: 'm-member' },
    subagent: { provider: 'p-sub', model: 'm-sub' },
  })
  subagents.startActivation({
    childId: 'child-a',
    provider: 'p-origin',
    request: { parent: { session: sessionWith() }, agentOptions: {} },
  })
  const sent = subagents.calls[0].request.agentOptions
  assert.deepEqual({ provider: sent.provider, model: sent.model }, { provider: 'p-sub', model: 'm-sub' },
    '成员集合为空时不得走 member 路由')
  assert.notEqual(sent.model, 'm-member', '不得误用 member 路由')
})

test('enabled=false：显式 provider/model/reasoningEffort/maxTokens 必须逐字段原样转发', () => {
  const { subagents } = install({
    enabled: false,
    member: { provider: 'p-member', model: 'm-member' },
    subagent: { provider: 'p-sub', model: 'm-sub' },
  })
  const requested = { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 123 }
  const session = () => sessionWith(memberEvent('child-a'))
  subagents.startActivation({ childId: 'child-a', provider: 'p-origin', request: { parent: { session: session() }, agentOptions: requested } })
  subagents.startActivation({ childId: 'stranger', provider: 'p-origin', request: { parent: { session: session() }, agentOptions: requested } })

  assert.equal(subagents.calls.length, 2, '透传仍必须逐次调用原 startActivation')
  assert.deepEqual(subagents.calls[0].request.agentOptions, { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 123 },
    '成员激活的 agentOptions 必须原样转发，不被 member 路由覆盖')
  assert.deepEqual(subagents.calls[1].request.agentOptions, requested, '非成员同样透传，不被 subagent 路由覆盖')
  assert.equal('reasoningEffort' in subagents.calls[0].request.agentOptions, true, 'enabled=false 不得删 reasoningEffort')
  assert.notEqual(subagents.calls[0].request.agentOptions.provider, DEFAULT_ROUTE.provider, '不得被默认路由覆盖')
  assert.deepEqual(requested, { provider: 'p', model: 'm', reasoningEffort: 'max', maxTokens: 123 }, '入参 agentOptions 不得被就地改写')
})

test('只配 subagent.model：注入侧 provider 回退默认、model 生效，member 保持全默认；DEFAULT_CONFIG 不被污染', () => {
  const { subagents } = install({ subagent: { model: 'm2' } })
  subagents.startActivation({ childId: 'child-a', provider: 'p-origin', request: { parent: { session: sessionWith(memberEvent('child-a')) }, agentOptions: {} } })
  subagents.startActivation({ childId: 'stranger', provider: 'p-origin', request: { parent: { session: sessionWith(memberEvent('child-a')) }, agentOptions: {} } })

  const member = subagents.calls[0].request.agentOptions
  const subagent = subagents.calls[1].request.agentOptions
  assert.deepEqual({ provider: member.provider, model: member.model }, DEFAULT_CONFIG.member, '未配置的 member 必须保持默认路由')
  assert.deepEqual({ provider: subagent.provider, model: subagent.model }, { provider: DEFAULT_CONFIG.subagent.provider, model: 'm2' },
    '只给 model 时 provider 必须回退默认、model 必须换成配置值')
  assert.notEqual(subagent.model, DEFAULT_CONFIG.subagent.model, 'model 必须真的被替换')
  assert.equal(subagent.provider, DEFAULT_CONFIG.subagent.provider, 'provider 不得被顺手改掉')

  const copy = resolveConfig({})
  assert.notEqual(copy, DEFAULT_CONFIG, 'resolveConfig 必须返回副本，不得交出 DEFAULT_CONFIG')
  copy.member.model = 'tampered'
  copy.enabled = false
  assert.equal(DEFAULT_CONFIG.enabled, true, 'DEFAULT_CONFIG 不得被调用方改动污染')
  assert.equal(DEFAULT_CONFIG.member.model, DEFAULT_ROUTE.model, 'DEFAULT_CONFIG 不得被调用方改动污染')
})

test('重复 apply 的 Symbol 守卫（行为侧）：一次激活只让底层执行一次，已生效路由不被替换', () => {
  const subagents = createSubagents()
  const warnings = []
  const host = createHost(subagents, warnings)
  apply(host.ctx, {})
  apply(host.ctx, { subagent: { model: 'm2' } })

  subagents.startActivation({ childId: 'stranger', provider: 'p-origin', request: { parent: { session: sessionWith(memberEvent('child-a')) }, agentOptions: {} } })
  assert.equal(subagents.calls.length, 1, '重复 apply 不得叠加包裹')
  assert.equal(subagents.calls[0].request.agentOptions.model, DEFAULT_CONFIG.subagent.model,
    '第二次 apply 的 config 不得替换已生效的路由')
  assert.equal(warnings.filter((message) => String(message).includes('包裹已安装')).length, 1,
    `重复 apply 必须恰好 warn 一次，实际：${JSON.stringify(warnings)}`)
})

/** teammate 父会话没有自己的 command/run 记录；只有团队 root 会话才有。 */
function createTeammateHost({ rootEnabled }) {
  const warnings = []
  const calls = []
  const rootSession = {
    events: rootEnabled
      ? [{ type: 'command/run', data: { name: 'using-agent-team', args: 'on' } }]
      : [],
  }
  const teammateSession = { events: [] }
  const subagents = {
    calls,
    startActivation(spec) { calls.push(spec); return { ok: true } },
    getProvider: () => ({ capabilities: { agentOptions: true } }),
  }
  const parent = { session: teammateSession }
  const agentTeams = {
    tryMembership: (agent) => (agent === parent ? { role: 'teammate', root: { session: rootSession } } : undefined),
  }
  const ctx = {
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: { uid: 'teammate-fiber' },
      settings: { configure: () => () => {} },
      logger: { warn: () => {} },
    }),
    logger: { warn: (message) => warnings.push(message) },
    get: (name) => (name === 'subagents' ? subagents : name === 'agentTeams' ? agentTeams : undefined),
    on: () => {},
    effect: (factory) => factory(),
    fiber: { uid: 'teammate-fiber' },
    settings: { configure: () => () => {} },
  }
  return { ctx, subagents, warnings, rootSession, teammateSession, parent }
}

test('缺陷1 回归：teammate 父会话自身无 command/run 记录时，仍按团队 root 会话注入 subagent 路由', () => {
  const host = createTeammateHost({ rootEnabled: true })
  apply(host.ctx, { member: { provider: 'p-member', model: 'm-member' }, subagent: { provider: 'p-sub', model: 'm-sub' } })

  host.subagents.startActivation({ provider: 'spawn', request: { parent: host.parent, agentOptions: {} } })

  assert.equal(host.subagents.calls[0].request.agentOptions.provider, 'p-sub', 'root 已开启时必须注入子代理路由')
  assert.equal(host.subagents.calls[0].request.agentOptions.model, 'm-sub')
})

test('缺陷1 回归：root 会话未开启 /using-agent-team 时不注入（teammate 父会话同样适用）', () => {
  const host = createTeammateHost({ rootEnabled: false })
  apply(host.ctx, {})

  host.subagents.startActivation({ provider: 'spawn', request: { parent: host.parent, agentOptions: { reasoningEffort: 'keep' } } })

  assert.equal('provider' in host.subagents.calls[0].request.agentOptions, false, 'root 未开启不得注入')
  assert.equal(host.subagents.calls[0].request.agentOptions.reasoningEffort, 'keep')
})

test('缺陷2 回归：非法 mode 在子代理路由路径也必须告警（不得静默回退），且逐次激活只 warn 一次', () => {
  const { subagents, warnings } = install({ mode: 'bogus' })
  subagents.startActivation({
    childId: 'child-mode-warn',
    provider: 'p-origin',
    request: { parent: { session: sessionWith(memberEvent('child-mode-warn')) }, agentOptions: {} },
  })
  const modeWarnings = warnings.filter((message) => /mode 取值非法/.test(message))
  assert.equal(modeWarnings.length, 1, `非法 mode 必须告警恰好一次，实际 warnings=${JSON.stringify(warnings)}`)
  assert.match(modeWarnings[0], /回退 'nested'/)

  subagents.startActivation({ provider: 'p-origin', request: { parent: { session: sessionWith() }, agentOptions: {} } })
  assert.equal(
    warnings.filter((message) => /mode 取值非法/.test(message)).length,
    1,
    '每次子代理激活都重新解析配置，逐次告警会刷屏',
  )
})
