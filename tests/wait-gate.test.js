/**
 * dsh-force-subagent wait_agent 空转拦截测试。
 * 契约（权威）：
 *   判据 = 本 turn（事件里最后一个 turn/start 之后）里最后一个 tool/call 的工具名是 wait_agent
 *   （排除本次调用自身：宿主在钩子前已写入该事件）→ deny（相邻两次 wait_agent 之间没有任何有效动作）；其余情况放行。
 *   fail-open：readEvents 抛错 → 放行且 warn 恰好一次。
 *   真实 apply(ctx) 登记的门禁处理器，不 mock 处理器自身。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'

/** 真实 ctx 的最小形状：与既有门禁测试同一套 createHost。 */
function createHost({ agentTeams } = {}) {
  const onCalls = []
  const warnings = []
  const services = {
    systemPrompt: { section: () => {} },
    commands: { register: () => {} },
    agentTeams,
  }
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    effect: (factory) => factory(),
    fiber: { uid: 'test-fiber' },
    settings: { configure: () => () => {} },
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: ctx.fiber ?? { uid: 'test-fiber' },
      settings: ctx.settings ?? { configure: () => () => {} },
      logger: ctx.logger,
    }),
    get: (service) => services[service],
    on: (...args) => {
      onCalls.push(args)
    },
  }
  return { ctx, onCalls, warnings }
}

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const toolCall = (name, callId) => ({ type: 'tool/call', data: { name, callId } })

/**
 * 当前调用自身的 tool/call 事件。真实宿主在 pre-execute 钩子之前就把它写入 session
 * （packages/core/agent-loop/src/tool-calls.ts:168→170），夹具必须复刻这条，否则会掩盖
 * 「判据命中当前调用自己」的缺陷。
 */
const currentCall = (name) => toolCall(name, `call-${name}`)

/** Lead 会话：真实形状只暴露 snapshotEvents()；tryMembership 未命中。 */
const leadAgent = (events) => ({
  id: 'lead-1',
  session: { snapshotEvents: () => events },
})
const leadHost = () => createHost({ agentTeams: { tryMembership: () => undefined } })

/** 成员会话：真实 TeamMembership 形状，root.session 是 Lead 会话。 */
const teammateAgent = (leadEvents, ownEvents) => ({
  id: 'mate-1',
  session: { snapshotEvents: () => ownEvents },
  membership: {
    role: 'teammate',
    id: 'team-1',
    name: 'worker-1',
    root: { session: { snapshotEvents: () => leadEvents } },
  },
})
const memberHost = () => createHost({ agentTeams: { tryMembership: (agent) => agent?.membership ?? undefined } })

const execOf = (name, agent) => ({
  callId: `call-${name}`,
  name,
  arguments: {},
  agent,
  signal: new AbortController().signal,
})

/** 取出插件真实登记的门禁处理器（不是 mock）。 */
const gateHandlers = (host) =>
  host.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)

/** 调用真实处理器链：next 计数判定放行是否真的生效，decisions 为已 await 的返回值。 */
async function gateOutcome(host, exec) {
  const handlers = gateHandlers(host)
  const nextResult = { kind: 'allow', via: 'next' }
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return Promise.resolve(nextResult)
  }
  const decisions = []
  let threw
  try {
    for (const handler of handlers) decisions.push(await handler(exec, next))
  } catch (error) {
    threw = error
  }
  return { decisions, threw, handlerCount: handlers.length, nextCalls }
}

/** 放行判据：不抛异常、无 deny、next 恰好一次。 */
async function assertAllowed(t, host, tool, agent, label) {
  const handlers = gateHandlers(host)
  assert.ok(
    handlers.length >= 1,
    `${label} / ${tool}：apply 未注册 ${GATE_EVENT} 处理器；实际监听：[${host.onCalls.map(([event]) => String(event)).join(', ') || '无'}]`,
  )
  const { decisions, threw, nextCalls } = await gateOutcome(host, execOf(tool, agent))
  assert.equal(
    threw,
    undefined,
    `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`,
  )
  assert.equal(
    decisions.filter((decision) => decision?.kind === 'deny').length,
    0,
    `${label} / ${tool}：不得 deny，实际 ${JSON.stringify(decisions)}`,
  )
  assert.equal(nextCalls, 1, `${label} / ${tool}：放行路径 next 必须恰好 1 次，实际 ${nextCalls}`)
}

/** deny 判据：不抛异常、next 0 次、reason 命中 hint 正则。 */
async function assertDenied(t, host, tool, agent, label, hint) {
  const handlers = gateHandlers(host)
  assert.ok(handlers.length >= 1, `${label} / ${tool}：apply 未注册 ${GATE_EVENT} 处理器`)
  const { decisions, threw, nextCalls } = await gateOutcome(host, execOf(tool, agent))
  assert.equal(
    threw,
    undefined,
    `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`,
  )
  const denied = decisions.filter((decision) => decision?.kind === 'deny')
  assert.equal(denied.length, 1, `${label} / ${tool}：必须恰好 deny 一次，实际 ${JSON.stringify(decisions)}`)
  assert.equal(nextCalls, 0, `${label} / ${tool}：deny 路径不得调用 next，实际 ${nextCalls} 次`)
  const reason = denied[0].reason
  assert.equal(typeof reason, 'string', `${label} / ${tool}：deny 的 reason 必须是 string`)
  assert.ok(reason.length > 0, `${label} / ${tool}：deny 的 reason 不得为空串`)
  assert.match(reason, hint, `${label} / ${tool}：reason 必须命中「${hint}」，实际为「${reason}」`)
}

test('W1 非 wait_agent 工具：不受空转拦截影响，next 恰好 1 次', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('wait_agent', 'call-prev-wait'), currentCall('list_agents')])
  await assertAllowed(t, host, 'list_agents', agent, 'W1 非 wait_agent 工具')
})

test('W2 本 turn 第一次 wait_agent：放行（next 1 次）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create', 'call-team_task_create'), currentCall('wait_agent')])
  await assertAllowed(t, host, 'wait_agent', agent, 'W2 本轮首次 wait_agent')
})

test('W3 紧邻第二次 wait_agent：deny（next 0 次，理由点名 list_agents / team_task_list）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('wait_agent', 'call-prev-wait'), currentCall('wait_agent')])
  await assertDenied(
    t,
    host,
    'wait_agent',
    agent,
    'W3 相邻两次 wait_agent',
    /list_agents|team_task_list/,
  )
})

test('W4 两次 wait_agent 之间夹了 bash：放行（成员白名单语义保持不变，next 1 次）', async (t) => {
  const host = memberHost()
  apply(host.ctx)
  const leadEvents = [runEvent('on'), turnStart(1)]
  const ownEvents = [turnStart(1), toolCall('wait_agent', 'call-prev-wait'), toolCall('bash', 'call-bash'), currentCall('wait_agent')]
  await assertAllowed(t, host, 'wait_agent', teammateAgent(leadEvents, ownEvents), 'W4 中间夹 bash')
})

test('W5 readEvents 抛错：fail-open 放行且 warn 恰好一次', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = {
    id: 'lead-1',
    session: {
      snapshotEvents: () => {
        throw new Error('snapshot boom')
      },
    },
  }
  await assertAllowed(t, host, 'wait_agent', agent, 'W5 读事件抛错')
  await assertAllowed(t, host, 'wait_agent', agent, 'W5 读事件抛错（第二次）')
  assert.equal(host.warnings.length, 1, `warn 必须恰好一次，实际 ${host.warnings.length}：${host.warnings.join(' | ')}`)
  assert.match(host.warnings[0], /wait_agent/, `warn 必须点名 wait_agent，实际为「${host.warnings[0]}」`)
  assert.match(host.warnings[0], /snapshot boom/, `warn 必须带原始错误信息，实际为「${host.warnings[0]}」`)
})

test('W6 事件含当前调用自身、本 turn 无更早 wait_agent：放行（next 1 次）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  // 真实时序：宿主先写入本次调用的 tool/call（callId 与 exec 相同），再跑 pre-execute 钩子。
  const agent = leadAgent([runEvent('on'), turnStart(1), currentCall('wait_agent')])
  await assertAllowed(t, host, 'wait_agent', agent, 'W6 事件含当前调用自身')
})

test('W7 当前调用自身 + 更早一条不同 callId 的 wait_agent 且中间无其他工具：deny（next 0 次）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([
    runEvent('on'),
    turnStart(1),
    toolCall('wait_agent', 'call-prev-wait'),
    currentCall('wait_agent'),
  ])
  await assertDenied(
    t,
    host,
    'wait_agent',
    agent,
    'W7 当前调用自身 + 更早 wait_agent',
    /list_agents|team_task_list/,
  )
})

test('W8 开关 off：连续两次 wait_agent 均放行（各 next 1 次）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const events = [runEvent('off'), turnStart(1)]
  const agent = leadAgent(events)
  await assertAllowed(t, host, 'wait_agent', agent, 'W8 off 第一次 wait_agent')
  events.push(toolCall('wait_agent', 'call-prev-wait'))
  await assertAllowed(t, host, 'wait_agent', agent, 'W8 off 第二次 wait_agent')
})

test('W9 无开启记录且 agent 无 session（gateSession 缺失）：放行且不抛错', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  await assertAllowed(t, host, 'wait_agent', { id: 'lead-1' }, 'W9 gateSession 缺失')
})
