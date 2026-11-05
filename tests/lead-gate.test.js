/**
 * dsh-force-subagent Lead 门禁测试。
 * 契约（权威）：
 *   EVIDENCE_TOOLS = ['bash', 'read', 'grep', 'glob']；
 *   拒绝条件 = Lead 会话（ctx.get('agentTeams').tryMembership(exec.agent) 未命中）
 *     + force-subagent 启用（Lead 会话最后一次 command/run（using-agent-team）args 非 off）
 *     + 本 turn（事件序列中最后一个 turn/start 之后）没有 team_task_create 的 tool/call 事件
 *     + 被调工具 ∈ EVIDENCE_TOOLS；
 *   其余全部放行（返回值必须是 next() 的结果）；成员会话（tryMembership 命中）继续走既有成员门禁分支；
 *   fail-open：读取会话事件（snapshotEvents）抛错 → 放行且不抛异常。
 * 断言口径：每条用例都核对 next 是否被调用与调用次数；deny 用例核对拒绝返回值的实际内容
 *   （JSON.stringify 后必须同时命中被拦工具名与 team_task_create）；放行用例核对 next 恰好一次且返回值来自 next()。
 * 构造方式与 tests/member-gate-deny.test.js、tests/member-gate-allow.test.js、tests/gate-observability.test.js 一致：
 *   真实 apply(ctx) 登记的 tools/pre-execute 处理器，不 mock 处理器自身。
 * 运行：node --test tests/lead-gate.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'

/** Lead 门禁拦的证据型工具。 */
const EVIDENCE_TOOLS = ['bash', 'read', 'grep', 'glob']

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
const toolCall = (name) => ({ type: 'tool/call', data: { name } })

/** Lead 会话：真实形状只暴露 snapshotEvents()；tryMembership 未命中。 */
const leadAgent = (events) => ({
  id: 'lead-1',
  session: { snapshotEvents: () => events },
})
const leadHost = () => createHost({ agentTeams: { tryMembership: () => undefined } })

/** 成员会话：真实 TeamMembership 形状，root.session 是 Lead 会话。 */
const teammateAgent = (leadEvents) => ({
  id: 'mate-1',
  session: { snapshotEvents: () => [] },
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

const stringify = (value) => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const noHandlerDiagnostic = (t, host, label, tool) => {
  const handlers = gateHandlers(host)
  if (handlers.length > 0) return handlers
  t.diagnostic(`未注册 ctx.on('${GATE_EVENT}', handler)：${label} / ${tool} 的断言无从验证`)
  return handlers
}

/** 放行判据：不抛异常、无 deny、next 恰好一次、返回值来自 next()（return undefined 不算放行）。 */
async function assertAllowed(t, host, tool, agent, label) {
  const handlers = noHandlerDiagnostic(t, host, label, tool)
  assert.ok(
    handlers.length >= 1,
    `${label} / ${tool}：apply 未注册 ${GATE_EVENT} 处理器，「放行」无从验证；实际监听：[${host.onCalls.map(([event]) => String(event)).join(', ') || '无'}]`,
  )

  const { decisions, threw, nextCalls } = await gateOutcome(host, execOf(tool, agent))
  assert.equal(
    threw,
    undefined,
    `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`,
  )
  for (const [index, decision] of decisions.entries()) {
    assert.notStrictEqual(
      decision?.kind,
      'deny',
      `${label} / ${tool}：不得 deny，处理器 #${index + 1} 返回 ${stringify(decision)}`,
    )
  }
  assert.equal(nextCalls, 1, `${label} / ${tool}：放行路径必须恰好调用 next 一次，实际 ${nextCalls} 次`)
  assert.ok(
    decisions.some((decision) => decision?.kind === 'allow' && decision?.via === 'next'),
    `${label} / ${tool}：返回值必须是 next() 的结果（kind === 'allow' / via === 'next'），实际 ${stringify(decisions)}`,
  )
}

/** 拒绝判据：不抛异常、存在 kind==='deny'、next 未被调用、拒绝返回值文本点名工具名与 hint（默认 team_task_create）。 */
async function assertDenied(t, host, tool, agent, label, hint = /team_task_create/) {
  const handlers = noHandlerDiagnostic(t, host, label, tool)
  assert.ok(
    handlers.length >= 1,
    `${label} / ${tool}：apply 未注册 ${GATE_EVENT} 处理器，「拒绝」无从验证；实际监听：[${host.onCalls.map(([event]) => String(event)).join(', ') || '无'}]`,
  )

  const { decisions, threw, nextCalls } = await gateOutcome(host, execOf(tool, agent))
  assert.equal(
    threw,
    undefined,
    `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`,
  )
  const denied = decisions.filter((decision) => decision?.kind === 'deny')
  assert.ok(
    denied.length >= 1,
    `${label} / ${tool}：必须 deny，实际处理器返回：${stringify(decisions)}`,
  )
  assert.equal(
    nextCalls,
    0,
    `${label} / ${tool}：deny 路径不得调用 next（既 deny 又 next = 拦截未生效），实际 next 被调用 ${nextCalls} 次`,
  )

  const serialized = stringify(decisions)
  assert.match(
    serialized,
    new RegExp(tool),
    `${label} / ${tool}：拒绝返回值必须点名被拦工具名「${tool}」，实际为 ${serialized}`,
  )
  assert.match(
    serialized,
    hint,
    `${label} / ${tool}：拒绝返回值必须命中「${hint}」提示，实际为 ${serialized}`,
  )
  for (const decision of denied) {
    assert.equal(
      typeof decision.reason,
      'string',
      `${label} / ${tool}：deny 的 reason 必须是 string，实际 ${typeof decision.reason}（${stringify(decision.reason)}）`,
    )
    assert.ok(
      decision.reason.length > 0,
      `${label} / ${tool}：deny 的 reason 不得为空串，实际为「${decision.reason}」`,
    )
  }
}

test(`契约：apply 注册 ${GATE_EVENT} 处理器（Lead 门禁断言的前提）`, (t) => {
  const host = leadHost()
  apply(host.ctx)
  const handlers = noHandlerDiagnostic(t, host, 'Lead', 'bash')
  assert.ok(
    handlers.length >= 1,
    `apply 未注册 ctx.on('${GATE_EVENT}', handler)；实际监听：[${host.onCalls.map(([event]) => String(event)).join(', ') || '无'}]`,
  )
  for (const [index, handler] of handlers.entries()) {
    assert.equal(typeof handler, 'function', `第 ${index + 1} 个 ${GATE_EVENT} 监听器不是函数`)
  }
})

test('L1 启用 + Lead + 本轮无 team_task_create：bash 必须 deny（next 0 次，理由点名 bash 与 team_task_create）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1)])
  await assertDenied(t, host, 'bash', agent, 'L1 Lead 已启用且本轮无 create')
})

test('L2 启用 + Lead + 本轮已有 team_task_create 的 tool/call：bash 放行（next 恰好 1 次）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('team_task_get')])
  await assertAllowed(t, host, 'bash', agent, 'L2 Lead 本轮已建看板')
})

test('L3 EVIDENCE_TOOLS 全表同规则：Lead 本轮无 create 时逐个 deny（next 0 次）', async (t) => {
  for (const tool of EVIDENCE_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1)])
      await assertDenied(t, host, tool, agent, `L3 Lead 已启用且本轮无 create（${tool}）`)
    })
  }
})

test('L4 force-subagent 未启用：bash 放行（next 恰好 1 次）', async (t) => {
  const CASES = [
    { label: '无 command/run 记录', events: [turnStart(1)] },
    { label: '最后一次记录 args=off', events: [runEvent('off'), turnStart(1)] },
    { label: '先 on 后 off（以最后一次为准）', events: [runEvent('on'), turnStart(1), runEvent('off'), turnStart(2)] },
  ]
  for (const { label, events } of CASES) {
    await t.test(label, async () => {
      const host = leadHost()
      apply(host.ctx)
      await assertAllowed(t, host, 'bash', leadAgent(events), `L4 ${label}`)
    })
  }
})

test('L5 非 EVIDENCE_TOOLS 工具不受 Lead 门禁影响：放行（next 恰好 1 次）', async (t) => {
  for (const tool of ['spawn_teammate', 'team_task_create', 'wait_agent']) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1)])
      await assertAllowed(t, host, tool, agent, `L5 编排类工具（${tool}）`)
    })
  }
})

test('L6 成员会话（tryMembership 命中）仍走既有成员门禁分支：bash deny、read/grep/glob 放行', async (t) => {
  for (const tool of EVIDENCE_TOOLS) {
    await t.test(tool, async () => {
      const host = memberHost()
      apply(host.ctx)
      const agent = teammateAgent([runEvent('on')])
      if (tool === 'bash') {
        // 既有成员门禁口径：deny + next 0 次 + reason 说明委派/subagent（见 tests/member-gate-deny.test.js）。
        await assertDenied(t, host, tool, agent, 'L6 成员会话（既有成员门禁口径）', /(委派|subagent)/)
      } else {
        await assertAllowed(t, host, tool, agent, 'L6 成员会话（只读工具既有放行）')
      }
    })
  }
})

test('L7 turn 边界：上一 turn 的 team_task_create 不算本轮证据，仍 deny（next 0 次）', async (t) => {
  const CASES = [
    {
      label: 'create 在前一 turn，随后 turn/start 开新 turn',
      events: [runEvent('on'), turnStart(1), toolCall('team_task_create'), turnStart(2)],
    },
    {
      label: '本 turn 只有非 create 的 tool/call',
      events: [runEvent('on'), turnStart(1), toolCall('team_task_create'), turnStart(2), toolCall('skill')],
    },
  ]
  for (const { label, events } of CASES) {
    await t.test(label, async () => {
      const host = leadHost()
      apply(host.ctx)
      await assertDenied(t, host, 'bash', leadAgent(events), `L7 ${label}`)
    })
  }
})

test('L8 fail-open：snapshotEvents 抛错时放行（next 恰好 1 次、不抛异常、不 deny）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = {
    id: 'lead-2',
    session: {
      snapshotEvents: () => {
        throw new Error('lead snapshot exploded')
      },
    },
  }
  await assertAllowed(t, host, 'bash', agent, 'L8 事件读取抛错 fail-open')
  assert.equal(host.warnings.length, 1, 'L8：fail-open 降级必须恰好 warn 一次（防刷屏）')
  assert.match(host.warnings[0], /bash/, 'L8：warn 文本必须点名被放行的工具')
  assert.match(host.warnings[0], /snapshot|事件|不可读/i, 'L8：warn 文本必须点名事件不可读的原因')
  assert.match(host.warnings[0], /放行|门禁未生效/, 'L8：warn 文本必须点名放行后果')
})

test('L9 Lead 启用但事件中无 turn/start：read 走 fail-open 放行（对齐 member-gate-allow B1/B2/B4a）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  await assertAllowed(t, host, 'read', leadAgent([runEvent('on')]), 'L9 无 turn/start fail-open')
})

const subAgentWithHeader = (delegationDepth) => ({
  id: 'sub-1',
  session: {
    header: { delegationDepth },
    snapshotEvents: () => [runEvent('on'), turnStart(1)],
  },
})

test('L10 subagent 会话头 delegationDepth=1：取证 read 不被 Lead 门禁误伤（放行）', async (t) => {
  // Lead 派出的取证据子代理：无 membership（tryMembership 返回 undefined），会话头 delegationDepth=1；
  // 判据：next 恰好 1 次、decisions 无 kind==='deny'、返回值 kind==='allow'（来自 next()）。
  const host = leadHost()
  apply(host.ctx)
  await assertAllowed(t, host, 'read', subAgentWithHeader(1), 'L10 subagent header.delegationDepth=1')
})

test('L10b 反向对照：同一 fixture header.delegationDepth=0（Lead）→ read 必须 deny（next 0）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  await assertDenied(t, host, 'read', subAgentWithHeader(0), 'L10b Lead 会话头 delegationDepth=0')
})

test('L10c 会话头缺失按 delegationDepth=0 处理（根会话）→ read 必须 deny（next 0 次）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = {
    id: 'sub-2',
    session: { snapshotEvents: () => [runEvent('on'), turnStart(1)] },
  }
  await assertDenied(t, host, 'read', agent, 'L10c header 缺失按 depth=0 deny')
})

test('L10d 会话头 getter 抛错：fail-open 放行且 warn 恰好 1 次', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = {
    id: 'sub-3',
    session: {
      get header() {
        throw new Error('header exploded')
      },
      snapshotEvents: () => [runEvent('on'), turnStart(1)],
    },
  }
  await assertAllowed(t, host, 'read', agent, 'L10d header 不可读 fail-open')
  assert.equal(host.warnings.length, 1, 'L10d：header 不可读降级必须恰好 warn 一次')
  assert.match(host.warnings[0], /read/, 'L10d：warn 必须点名被放行的工具')
  assert.match(host.warnings[0], /header|exploded|不可读/i, 'L10d：warn 必须点名原因')
  assert.match(host.warnings[0], /放行|门禁未生效/, 'L10d：warn 必须点名放行后果')
})
