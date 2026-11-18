/**
 * 模型路由配置测试：resolveConfig 深合并与回退、成员/子代理路由分流、enabled 透传。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply, resolveConfig, isReviewerActivation, memberIds, DEFAULT_CONFIG, DEFAULT_ROUTE } = plugin

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
  // 与 tests/mode-flat.test.js 同一口径：systemPrompt / commands 必须给到位。缺任何一个都会让
  // apply 自己告警「服务未就绪」，那条无关告警会污染 reviewer 用例的 warn 计数断言。
  const systemPrompt = { sections: [], section: (definition) => { systemPrompt.sections.push(definition) } }
  const commands = { registered: [], register: (definition) => { commands.registered.push(definition) } }
  const ctx = {
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: ctx.fiber ?? { uid: 'test-fiber' },
      settings: ctx.settings ?? { configure: () => () => {} },
      logger: ctx.logger,
    }),
    logger: { warn: (message) => warnings.push(message) },
    get: (service) => (
      service === 'subagents' ? subagents
        : service === 'systemPrompt' ? systemPrompt
          : service === 'commands' ? commands
            : undefined
    ),
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

// ── reviewer（审查代码模型）路由：配置解析、优先级链与注入 ────────────────────

const REVIEWER_ROUTE = { provider: 'review-prov', model: 'review-model' }
/**
 * reviewer 用例的 warn 口径：夹具已提供 systemPrompt / commands 服务，apply 不该再出现
 * 「服务未就绪」这类无关告警。这里不过滤而是先证明这一点——否则「不得告警」的断言会被
 * 无关告警污染，真正的 reviewer 告警反而被掩盖。
 */
const reviewWarnings = (warnings) => {
  const notReady = warnings.filter((message) => /服务未就绪/.test(message))
  assert.deepEqual(notReady, [], `夹具必须提供 systemPrompt / commands 服务，否则 warn 计数断言失真：${JSON.stringify(notReady)}`)
  return warnings
}

test('R0 默认配置不挂 reviewer 字段：DEFAULT_CONFIG 与 resolveConfig(空) 仍深相等', () => {
  assert.equal('reviewer' in DEFAULT_CONFIG, false, 'DEFAULT_CONFIG 不得新增 reviewer 键')
  assert.equal('reviewer' in resolveConfig(undefined), false, '未配置 reviewer 不得挂 reviewer: undefined')
  assert.equal('reviewer' in resolveConfig({}), false)
  assert.equal('reviewer' in resolveConfig({ reviewer: { provider: '', model: '' } }), false, '面板留空写回的两段空串等于未配置')
  assert.equal('reviewer' in resolveConfig({ reviewer: {} }), false)
  assert.equal('reviewer' in resolveConfig({ reviewer: null }), false)
  assert.deepEqual(resolveConfig({ reviewer: { provider: '', model: '' } }), DEFAULT_CONFIG)
})

test('R1 全局 reviewer 配齐才生效；只配一半整条忽略并 warn-once', () => {
  const warnings = []
  const warn = (message) => warnings.push(message)
  assert.deepEqual(resolveConfig({ reviewer: REVIEWER_ROUTE }, warn).reviewer, REVIEWER_ROUTE)

  assert.equal('reviewer' in resolveConfig({ reviewer: { provider: 'only-p', model: '' } }, warn), false, '缺 model 不得注入残缺路由')
  assert.equal('reviewer' in resolveConfig({ reviewer: { provider: '', model: 'only-m' } }, warn), false, '缺 provider 不得注入残缺路由')
  assert.equal('reviewer' in resolveConfig({ reviewer: { provider: 42, model: 'm' } }, warn), false, '非字符串不得算配置')

  const halfWarnings = warnings.filter((message) => /只配置了一半/.test(message))
  assert.equal(halfWarnings.length, 1, `半残 reviewer 路由必须恰好告警一次，实际 ${halfWarnings.length} 次：${JSON.stringify(halfWarnings)}`)
  assert.match(halfWarnings[0], /reviewer/)

  // 同一处半残配置在每次实时解析里都会重来，逐次告警会刷屏。
  resolveConfig({ reviewer: { provider: 'only-p', model: '' } }, warn)
  resolveConfig({ reviewer: { provider: '', model: 'only-m' } }, warn)
  assert.equal(warnings.filter((message) => /只配置了一半/.test(message)).length, 1, 'warn-once 失效：重复解析仍在告警')
})

test('R2 工作区 reviewer 逐项解析：配齐才挂字段，半残告警且不挂', () => {
  const warnings = []
  const value = resolveConfig({
    workspaces: {
      '/repo/a': { reviewer: REVIEWER_ROUTE },
      '/repo/b': { reviewer: { provider: 'half', model: '' } },
      '/repo/c': { reviewer: { provider: '', model: '' } },
    },
  }, (message) => warnings.push(message))

  assert.deepEqual(value.workspaces['/repo/a'].reviewer, REVIEWER_ROUTE)
  assert.equal('reviewer' in value.workspaces['/repo/b'], false, '半残配置不得留在工作区条目里')
  assert.equal('reviewer' in value.workspaces['/repo/c'], false)
  assert.deepEqual(Object.keys(value.workspaces['/repo/c']), ['member', 'subagent'], '未配 reviewer 的工作区条目形状不得变化')
  assert.equal(warnings.filter((message) => /只配置了一半/.test(message)).length, 1, '/repo/b 的半残配置必须告警一次')
  assert.match(warnings.find((message) => /只配置了一半/.test(message)), /\/repo\/b/)
})

test('R3 审查代码的激活命中 reviewer 路由：Lead 直系与 teammate 的下级都改用 reviewer 路由', () => {
  const config = { member: { provider: 'm-p', model: 'm-m' }, subagent: { provider: 's-p', model: 's-m' }, reviewer: REVIEWER_ROUTE }

  const member = install(config)
  member.subagents.startActivation({
    childId: 'child-reviewer',
    name: 'reviewer',
    provider: 'spawn',
    label: 'review impl',
    request: { parent: { session: sessionWith(memberEvent('child-reviewer')) }, agentOptions: { reasoningEffort: 'high', temperature: 0.2 } },
  })
  assert.deepEqual(
    { provider: member.subagents.calls[0].request.agentOptions.provider, model: member.subagents.calls[0].request.agentOptions.model },
    REVIEWER_ROUTE,
    '成员身份的 reviewer 必须走 reviewer 路由而不是 member 路由',
  )
  assert.equal(member.subagents.calls[0].request.agentOptions.reasoningEffort, undefined, '注入必须照旧删除 reasoningEffort')
  assert.equal(member.subagents.calls[0].request.agentOptions.temperature, 0.2, '其余 agentOptions 字段保留')

  const descent = install(config)
  descent.subagents.startActivation({
    name: 'code-reviewer',
    provider: 'spawn',
    label: 'do work',
    request: { parent: { session: sessionWith() }, agentOptions: {} },
  })
  assert.deepEqual(
    { provider: descent.subagents.calls[0].request.agentOptions.provider, model: descent.subagents.calls[0].request.agentOptions.model },
    REVIEWER_ROUTE,
    'teammate 的下级只要是审查代码，同样走 reviewer 而不是 subagent 路由',
  )
  assert.deepEqual(reviewWarnings(descent.warnings), [], '正常注入不得追加 reviewer 相关告警')
})

test('R4 reviewer 未配置：审查代码的激活完全回退原有 member / subagent 路由，行为与改动前一致', () => {
  const member = install({ member: { provider: 'm-p', model: 'm-m' }, subagent: { provider: 's-p', model: 's-m' } })
  member.subagents.startActivation({
    childId: 'child-reviewer-2',
    name: 'reviewer-1',
    provider: 'spawn',
    label: 'review impl',
    request: { parent: { session: sessionWith(memberEvent('child-reviewer-2')) }, agentOptions: {} },
  })
  assert.deepEqual(
    { provider: member.subagents.calls[0].request.agentOptions.provider, model: member.subagents.calls[0].request.agentOptions.model },
    { provider: 'm-p', model: 'm-m' },
    '没配 reviewer 时成员就是成员，不得因为名字是 reviewer 就落默认路由',
  )

  const plain = install({ member: { provider: 'm-p', model: 'm-m' }, subagent: { provider: 's-p', model: 's-m' }, reviewer: REVIEWER_ROUTE })
  plain.subagents.startActivation({
    name: 'impl',
    provider: 'spawn',
    label: '实现审查代码模型',
    request: { parent: { session: sessionWith() }, agentOptions: {} },
  })
  assert.deepEqual(
    { provider: plain.subagents.calls[0].request.agentOptions.provider, model: plain.subagents.calls[0].request.agentOptions.model },
    { provider: 's-p', model: 's-m' },
    '配了 reviewer 也不能把实现类成员抢过去：label 里有「审查代码」不算审查任务',
  )
})

test('R5 工作区 reviewer 覆盖全局 reviewer，未命中的工作区回退全局 reviewer', () => {
  const scoped = { provider: 'ws-review-prov', model: 'ws-review-model' }
  const installed = install({
    reviewer: REVIEWER_ROUTE,
    workspaces: { '/repo/a': { reviewer: scoped } },
  })
  const workspaceSession = (cwd) => ({ events: [enableEvent()], cwd, header: { cwd } })

  installed.subagents.startActivation({
    name: 'reviewer',
    provider: 'spawn',
    label: 'review',
    request: { parent: { session: workspaceSession('/repo/a') }, agentOptions: {} },
  })
  assert.deepEqual(
    { provider: installed.subagents.calls[0].request.agentOptions.provider, model: installed.subagents.calls[0].request.agentOptions.model },
    scoped,
    '工作区 reviewer 必须优先于全局 reviewer',
  )

  installed.subagents.startActivation({
    name: 'reviewer',
    provider: 'spawn',
    label: 'review',
    request: { parent: { session: workspaceSession('/repo/other') }, agentOptions: {} },
  })
  assert.deepEqual(
    { provider: installed.subagents.calls[1].request.agentOptions.provider, model: installed.subagents.calls[1].request.agentOptions.model },
    REVIEWER_ROUTE,
    '未命中工作区条目时回退全局 reviewer',
  )
  assert.deepEqual(installed.warnings, [], '两级 reviewer 都在时不得告警')
})

test('R6 工作区只配了 member / subagent 时，审查代码的激活回退全局 reviewer 而不是工作区 member', () => {
  const installed = install({
    reviewer: REVIEWER_ROUTE,
    workspaces: { '/repo/a': { member: { provider: 'ws-m-p', model: 'ws-m-m' }, subagent: { provider: 'ws-s-p', model: 'ws-s-m' } } },
  })
  const cwd = '/repo/a'
  installed.subagents.startActivation({
    name: 'reviewer',
    provider: 'spawn',
    label: 'review',
    request: { parent: { session: { events: [enableEvent()], cwd, header: { cwd } } }, agentOptions: {} },
  })
  assert.deepEqual(
    { provider: installed.subagents.calls[0].request.agentOptions.provider, model: installed.subagents.calls[0].request.agentOptions.model },
    REVIEWER_ROUTE,
    'reviewer 优先级链是 工作区 reviewer > 全局 reviewer > member / subagent：工作区没配 reviewer 就落到全局 reviewer',
  )
})

test('R7 enabled=false 时 reviewer 同样完全不生效：整体透传', () => {
  const installed = install({ enabled: false, reviewer: REVIEWER_ROUTE })
  const agentOptions = { provider: 'caller-p', model: 'caller-m', reasoningEffort: 'low' }
  installed.subagents.startActivation({ name: 'reviewer', provider: 'spawn', label: 'review', request: { parent: { session: sessionWith() }, agentOptions } })
  assert.equal(installed.subagents.calls[0].request.agentOptions, agentOptions, 'enabled=false 必须连对象身份都不改')
})

// ── isReviewerActivation：reviewer 路由的判据边界 ──────────────────────────────
// 三段判定（name → agentPreset → label），从严到宽：文案里出现「审查」二字绝不误判成审查任务。

/** 生产扁平形状：宿主 spec 与 request 同源（index.js 里 request === spec）。 */
const flatActivation = ({ name, label, agentPreset } = {}) => {
  const spec = { provider: 'spawn', prompt: [{ type: 'text', text: 'work' }], signal: new AbortController().signal }
  if (name !== undefined) spec.name = name
  if (label !== undefined) spec.label = label
  if (agentPreset !== undefined) spec.agentPreset = agentPreset
  return spec
}
const verdict = ({ name, label, agentPreset } = {}) => isReviewerActivation(flatActivation({ name, label, agentPreset }), flatActivation({ name, label, agentPreset }))

test('R8 isReviewerActivation：name 命中 reviewer / review 家族（含编号与连字符前缀），大小写与首尾空白不影响判定', () => {
  for (const [name, expected] of [
    ['reviewer', true], ['reviewer-1', true], ['reviewer-12', true], ['code-reviewer', true],
    ['adversarial-reviewer', true], ['review', true], ['code-review', true], ['code-review-1', true],
    ['Reviewer', true], ['  reviewer  ', true], ['REVIEW-2', true],
    ['coder', false], ['impl-reviewer-ui', false], ['reviewer-ui', false], ['reviewerx', false],
    ['senior_reviewer', false], ['bug-review', false], ['review-model-config', false], ['', false],
  ]) {
    assert.equal(verdict({ name, label: 'impl' }), expected, `name=${JSON.stringify(name)} 的判定必须是 ${expected}`)
  }
})

test('R9 isReviewerActivation：给了 name 就只认 name，label 再像审查任务也不得改判', () => {
  for (const [name, label] of [
    ['coder', '实现审查代码模型'], ['coder', '代码审查'], ['coder', 'code review'], ['coder', 'review'],
    ['impl-reviewer-ui', '对抗审查'], ['impl', '代码审查'], ['reviewer-ui', '代码审查'],
  ]) {
    assert.equal(verdict({ name, label }), false, `name=${JSON.stringify(name)} + label=${JSON.stringify(label)}：名字是非审查名字，必须判 false`)
  }
  // 反向同样成立：name 是审查名字时，label 是实现类文案也判 true（判定不因 label 动摇）。
  assert.equal(verdict({ name: 'reviewer', label: '实现审查代码模型' }), true, 'name 命中即算审查任务')
})

test('R10 isReviewerActivation：无 name 时 agentPreset 命中 reviewer 家族；preset 不命中时仍看 label，但 label 必须自身是明确审查意图', () => {
  assert.equal(verdict({ agentPreset: 'reviewer' }), true, 'preset=reviewer 必须命中')
  assert.equal(verdict({ agentPreset: 'code-reviewer', label: 'impl' }), true, 'preset 命中时不必再看 label')
  assert.equal(verdict({ agentPreset: 'reviewer-1', label: '实现审查代码模型' }), true, 'preset 命中不得被实现类 label 动摇')
  assert.equal(verdict({ agentPreset: 'coder', label: 'impl' }), false, 'preset 与 label 都不是审查任务')
  assert.equal(verdict({ agentPreset: 'coder', label: '代码审查' }), true, 'preset 是弱信号：不是 reviewer 时 label 仍然兜底')
  assert.equal(verdict({ agentPreset: 'coder', label: '修复代码审查bug' }), false, 'preset 不命中 + 实现类 label 必须判 false')
})

test('R11 isReviewerActivation：无 name 无 preset 时只认「这条任务本身就是审查代码」的 label', () => {
  for (const [label, expected] of [
    ['代码审查', true], ['审查代码', true], ['对抗审查', true], ['代码评审', true], ['评审代码', true],
    ['code review', true], ['code-review', true], ['codereview', true], ['review', true], ['review impl', true],
    ['reviewer', true], ['code review: round 2', true],
    ['实现审查代码模型', false], ['修复代码审查bug', false], ['审查一下这段代码', false], ['审查', false],
    ['代码', false], ['impl', false], ['implement review model fix', false], ['do work', false],
  ]) {
    assert.equal(verdict({ label }), expected, `label=${JSON.stringify(label)} 的判定必须是 ${expected}`)
  }
})

test('R12 isReviewerActivation：缺字段 / 非法字段 / 空 label 不抛，一律 false（含 spec 与 request 都为 undefined）', () => {
  assert.equal(isReviewerActivation(undefined, undefined), false, 'spec 与 request 都缺失不得抛')
  assert.equal(isReviewerActivation({}, {}), false)
  assert.equal(isReviewerActivation(flatActivation({ label: '' }), flatActivation({ label: '' })), false, '空 label 不是审查任务')
  assert.equal(isReviewerActivation(flatActivation({ label: '   ' }), flatActivation({ label: '   ' })), false, '只有空白的 label 不是审查任务')
  assert.equal(verdict({ name: 42, label: 'impl' }), false, '非字符串 name 按「未给 name」处理，不因非法值抛异常')
  assert.equal(verdict({ name: 42, label: '代码审查' }), true, '非字符串 name 视同未给 name：此时判定落到 label，不得静默丢掉审查任务')
  assert.equal(verdict({ label: 42 }), false, '非字符串 label 按未给 label 处理')
  // 同一份字段在扁平与嵌套两种入参形状下判定必须一致：注入路径两条都走。
  assert.equal(isReviewerActivation({ name: 'code-reviewer', label: 'impl' }, { agentPreset: 'reviewer' }), true, '嵌套形状同样按 name 判定')
})

// 实现类 label：审查词组只是「待处理的对象」，不是这条任务自身的意图。判据必须锚定在 label 开头的
// 审查意图，一旦退回非锚定子串匹配（旧 REVIEWER_LABEL_PHRASE_RE 的写法），R13 / R14 必须变红。
const IMPL_LABEL_SAMPLES = [
  '修复 code review 面板的崩溃', '实现 code review 能力', '给 code-review 加个按钮', '修复 code review 的 bug',
  'implement code review feature', 'add code review button',
]

test('R13 isReviewerActivation：Lead 实测复现的误判样例（实现类 label）修复后必须判 false', () => {
  for (const label of IMPL_LABEL_SAMPLES) {
    assert.equal(verdict({ label }), false, `label=${JSON.stringify(label)} 是实现类任务：审查词组不在 label 开头，必须判 false（否则实现任务会被送进审查代码模型）`)
  }
  // 实现类 label 也不许被 preset 这种弱信号翻案。
  for (const label of IMPL_LABEL_SAMPLES) {
    assert.equal(verdict({ agentPreset: 'coder', label }), false, `preset=coder + label=${JSON.stringify(label)}：preset 不命中且 label 是实现类，必须判 false`)
  }
})

test('R14 isReviewerActivation：不变式 —— 审查词组只出现在 label 中间 / 末尾时一律 false（禁止任意位置子串匹配）', () => {
  const phrases = ['code review', 'code-review', 'codereview', 'code reviewer', 'Code Review']
  const wrappers = [
    (p) => `修复 ${p} 面板的崩溃`, (p) => `实现 ${p} 能力`, (p) => `给 ${p} 加个按钮`, (p) => `修复 ${p} 的 bug`,
    (p) => `fix the ${p} crash`, (p) => `add ${p} button`, (p) => `implement ${p} feature`,
    (p) => `面板崩溃修复（${p}）`, (p) => `任务：${p} 崩溃修复`,
  ]
  for (const phrase of phrases) {
    for (const wrap of wrappers) {
      const label = wrap(phrase)
      assert.equal(verdict({ label }), false, `label=${JSON.stringify(label)}：审查词组 ${JSON.stringify(phrase)} 不在 label 开头，属实现类任务，必须判 false（判据必须锚定在 label 开头）`)
    }
  }
  // 同一组 label 不得因为「label 里含 reviewer 这个词」被 name 判据捞回来：name 判据同样锚定。
  for (const label of ['修复 reviewer 面板崩溃', 'reviewer 面板崩溃修复', 'implement reviewer routing', '修复 code-review 崩溃', '面板 bug：code review 崩溃', '审查代码模型配置迁移']) {
    assert.equal(verdict({ label }), false, `label=${JSON.stringify(label)}：整条 label 不是 reviewer 名字也不是开头审查意图，必须判 false`)
  }
})

test('R15 isReviewerActivation：锚定不得过头 —— 开头即审查意图的 label 仍须命中（防止用「一律 false」糊弄 R13/R14）', () => {
  for (const label of [
    '代码审查', '审查代码', '对抗审查', '代码评审', '评审代码',
    'code review this diff', 'code-review the diff', 'code reviewer needed', 'review the diff', 'review impl',
    'review the code', 'reviewing changes', 'please code review this diff',
    '  code review this diff  ', '\nreview the diff\n',
  ]) {
    assert.equal(verdict({ label }), true, `label=${JSON.stringify(label)} 以审查意图开头，必须判 true（漏判只回退 member/subagent 路由，但这里不该漏）`)
  }
})

test('R16 isReviewerActivation：裸 review 的宾语不许任意 —— 只有代码审查宾语、整条结束或轮次编号标注才命中', () => {
  // 宾语可选时（旧写法 review(?:ing)?(?:\\s+(?:code|diff|pr|changes|impl\\w*))?），
  // 下面四条「评审别的对象」的 label 全部误判为 true，与「宁可漏判」的口径冲突。
  for (const [label, expected] of [
    ['review 需求文档', false], ['review 面板文案', false], ['review the docs', false], ['review 配置迁移', false],
    ['review docs', false], ['review requirements', false], ['review the plan', false], ['review 文案', false],
    ['please review 需求文档', false], ['review 需求文档 第二轮', false],
    ['review the diff', true], ['review impl', true], ['review the code', true], ['reviewing changes', true],
    ['review: round 2', true], ['review', true], ['reviewing', true], ['please review the diff', true],
    ['review commit', true], ['reviewing patch changes', true],
  ]) {
    assert.equal(verdict({ label }), expected, `label=${JSON.stringify(label)} 的判定必须是 ${expected}`)
  }
  // 收紧只作用于「review 开头 + 宾语」这一族；code review 词组族与中文族不得被连带砍掉。
  for (const label of ['code review', 'code-review the diff', 'code reviewer needed', '代码审查', '评审代码']) {
    assert.equal(verdict({ label }), true, `label=${JSON.stringify(label)} 属于 code review / 中文审查词组族，收紧后仍必须判 true`)
  }
})
