/**
 * dsh-force-subagent Lead 门禁测试。
 * 契约（权威）：
 *   EVIDENCE_TOOLS = ['bash', 'read', 'grep', 'glob', 'web_fetch', 'web_search', 'read_image', 'pwsh']
 *     （取证旁路 read_image / pwsh 的逐名核对与专项断言见 tests/lead-gate-bypass-tools.test.js；
 *      持久化 pwsh 注册的模型可见名同样是 pwsh）；
 *   IMPLEMENTATION_TOOLS = ['write', 'edit', 'apply_patch', 'str_replace_editor']（宿主真实注册名：
 *     packages/fs/tool-fs/src/write.ts:74 / edit.ts:86 / apply-patch.ts:27、
 *     packages/fs/tool-str-replace-editor/src/index.ts:430；宿主无 multi_edit，故不列）；
 *   EXECUTION_TOOLS = ['run_code', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal']
 *     （宿主真实注册名：packages/core/tool-executor-ptc/src/ptc.ts:298 + packages/core/tools/src/contracts.ts:12、
 *      packages/experimental/tool-terminal/src/index.ts:166 / :203 / :307 / :340；terminal_close / terminal_list
 *      是终端生命周期簿记、不在集合内，理由见 index.js 注释）；
 *   Lead 提醒触发集合 = 三类并集（取证 8 + 实现 4 + 执行 5 = 17），同一判据；
 *   提醒条件 = Lead 会话（ctx.get('agentTeams').tryMembership(exec.agent) 未命中）
 *     + force-subagent 启用（Lead 会话最后一次 command/run（using-agent-team）args 非 off）
 *     + 被调工具 ∈ 三类并集
 *     + 本 turn（事件序列中最后一个 turn/start 之后）没有委派类 tool/call（subagent / subagent 系列 / workflow）
 *     → 经 agent.inject 投递一条 [team-gate] 提醒，随后 return next() 放行；插件不返回任何拒绝结果。
 *   去重粒度 = 轮次：提醒 key = lead-evidence:${最后一个 turn/start 的下标}，同轮只提醒一次，
 *     新的 turn/start 到来（Lead 收到新消息）后重新提醒一次；
 *   会话是否还有 running 成员、本轮是否 interrupt_agent 过成员都不参与判定（hasRunningMember 与 interrupt_agent 判据已移除）；
 *   编排类工具（team_task_* / subagent / send_message / wait_agent / list_agents / interrupt_agent）不受影响；
 *   单靠 team_task_create 不算已派发（仍提醒一次）；
 *   其余全部放行（返回值必须是 next() 的结果）；成员会话（tryMembership 命中）继续走既有成员门禁分支；
 *   fail-open：读取会话事件（snapshotEvents）抛错 → 放行、不提醒、不抛异常。
 * 断言口径：每条用例都核对 next 是否被调用与调用次数；提醒用例核对恰好一条提醒
 *   （点名工具名与 team_task_create / subagent 出路）+ next 恰好一次 + 无 deny；放行用例核对
 *   next 恰好一次、返回值来自 next() 且不投递提醒。
 * 构造方式与 tests/member-gate-deny.test.js、tests/member-gate-allow.test.js、tests/gate-observability.test.js 一致：
 *   真实 apply(ctx) 登记的 tools/pre-execute 处理器，不 mock 处理器自身。
 * 运行：node --test tests/lead-gate.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'

/** Lead 门禁拦的证据型工具（含取证旁路 read_image / pwsh，专项核对见 tests/lead-gate-bypass-tools.test.js）。 */
const EVIDENCE_TOOLS = ['bash', 'read', 'grep', 'glob', 'web_fetch', 'web_search', 'read_image', 'pwsh']

/** Lead 门禁拦的实现型工具：封「被拒取证后转而自己写文件」的绕行。 */
const IMPLEMENTATION_TOOLS = ['write', 'edit', 'apply_patch', 'str_replace_editor']

/**
 * Lead 门禁拦的执行型工具：封「被拒 bash / write 之后改用宿主另外两条执行通道」的绕行。
 * 逐个核对宿主 0.2.2-rc.1 真实注册名：run_code 见 packages/core/tool-executor-ptc/src/ptc.ts:298
 * （name: RUN_CODE_NAME，值 'run_code' 见 packages/core/tools/src/contracts.ts:12；模型可见名表见
 * packages/core/tools/tests/gen-tool-catalog.spec.ts:36）；terminal_open / terminal_send / terminal_read /
 * terminal_signal 见 packages/experimental/tool-terminal/src/index.ts:166 / :203 / :307 / :340（模型可见名表见
 * 同 spec :41-42，宿主只有这一个注册点）。terminal_close（:365）/ terminal_list（:396）是终端生命周期簿记、
 * 自身不执行任何东西，且终端只能由已被拦的 terminal_open 建立，故不在集合内。
 */
const EXECUTION_TOOLS = ['run_code', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal']

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
/** 真实 team/member 事件形状（宿主 types.ts:230，phase ∈ provisioning / active / failed）。 */
const memberEvent = (id, phase = 'active') => ({
  type: 'team/member',
  data: { version: 2, teamId: 'team-1', member: { id, name: `worker-${id}`, role: 'teammate', phase } },
})
const taskEvent = (id, status, ownerId) => ({
  type: 'team/task',
  data: { version: 2, teamId: 'team-1', task: { id, subject: `task ${id}`, status, revision: 1, blockedBy: [], ownerId } },
})

/** Lead 会话：真实形状只暴露 snapshotEvents()；tryMembership 未命中。notices/inject 复刻宿主 Agent 的 notice 通道，供软门禁提醒断言。 */
const leadAgent = (events) => {
  const agent = {
    id: 'lead-1',
    session: { snapshotEvents: () => events },
    notices: [],
    inject(message) { this.notices.push(message) },
  }
  return agent
}
const leadHost = () => createHost({ agentTeams: { tryMembership: () => undefined } })

/** 成员会话：真实 TeamMembership 形状，root.session 是 Lead 会话。 */
const teammateAgent = (leadEvents) => ({
  id: 'mate-1',
  session: { snapshotEvents: () => [] },
  notices: [],
  inject(message) { this.notices.push(message) },
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
  assert.equal(agent?.notices?.length ?? 0, 0, `${label} / ${tool}：未命中判据的放行路径不得投递提醒，实际 ${agent?.notices?.length ?? 0} 条`)
}

/** 软门禁判据（task-22 口径）：不抛异常、无 deny、next 恰好一次且返回值来自 next()，并恰好投递一条点名工具名与 hint 的提醒。 */
async function assertReminded(t, host, tool, agent, label, hint = /team_task_create/) {
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
      `${label} / ${tool}：软门禁不得 deny，处理器 #${index + 1} 返回 ${stringify(decision)}`,
    )
  }
  assert.equal(nextCalls, 1, `${label} / ${tool}：放行路径必须恰好调用 next 一次，实际 ${nextCalls} 次`)
  assert.ok(
    decisions.some((decision) => decision?.kind === 'allow' && decision?.via === 'next'),
    `${label} / ${tool}：返回值必须是 next() 的结果（kind === 'allow' / via === 'next'），实际 ${stringify(decisions)}`,
  )

  const notices = agent?.notices ?? []
  assert.equal(notices.length, 1, `${label} / ${tool}：必须恰好投递一条软门禁提醒，实际 ${notices.length} 条`)
  const text = notices[0]?.content?.[0]?.text
  assert.equal(typeof text, 'string', `${label} / ${tool}：提醒正文必须是 string，实际 ${typeof text}`)
  assert.ok(typeof text === 'string' && text.length > 0, `${label} / ${tool}：提醒正文不得为空串`)
  assert.equal(notices[0]?.source?.form, 'notice', `${label} / ${tool}：提醒必须走 notice 通道，实际 ${stringify(notices[0]?.source)}`)
  assert.match(text, new RegExp(tool), `${label} / ${tool}：提醒必须点名被劝阻的工具名「${tool}」，实际为「${text}」`)
  assert.match(text, hint, `${label} / ${tool}：提醒必须命中「${hint}」，实际为「${text}」`)
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

test('L1 启用 + Lead + 本轮无派发：bash 放行并提醒一次（提醒点名 bash 与 team_task_create / subagent）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1)])
  await assertReminded(t, host, 'bash', agent, 'L1 Lead 已启用且本轮无派发', /team_task_create[\s\S]*subagent/)
})

test('L2 启用 + Lead + 本轮只有 team_task_create（没有派发）：bash 放行并提醒一次（单靠看板不算已派活）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('team_task_get')])
  await assertReminded(t, host, 'bash', agent, 'L2 Lead 只建了看板就下场取证', /team_task_create[\s\S]*subagent/)
})

test('L3 EVIDENCE_TOOLS 全表同规则：Lead 本轮无派发时逐个放行 + 提醒一次', async (t) => {
  for (const tool of EVIDENCE_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1)])
      await assertReminded(t, host, tool, agent, `L3 Lead 已启用且本轮无派发（${tool}）`, /team_task_create[\s\S]*subagent/)
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

test('L5 编排类工具不受 Lead 门禁影响：一律放行（next 恰好 1 次）', async (t) => {
  const ORCHESTRATION = [
    'spawn_teammate',
    'team_task_create',
    'team_task_get',
    'team_task_list',
    'team_task_update',
    'send_message',
    'list_agents',
    'wait_agent',
    'interrupt_agent',
  ]
  for (const tool of ORCHESTRATION) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1)])
      await assertAllowed(t, host, tool, agent, `L5 编排类工具（${tool}）`)
    })
  }
})

test('L6 成员会话（tryMembership 命中）仍走既有成员门禁分支：白名单外提醒、白名单内放行', async (t) => {
  // nested 成员白名单只有 read / grep / glob 是证据型工具，bash / web_fetch / web_search 在名单外。
  const MEMBER_ALLOWED_EVIDENCE = new Set(['read', 'grep', 'glob'])
  for (const tool of EVIDENCE_TOOLS) {
    await t.test(tool, async () => {
      const host = memberHost()
      apply(host.ctx)
      const agent = teammateAgent([runEvent('on')])
      if (MEMBER_ALLOWED_EVIDENCE.has(tool)) {
        await assertAllowed(t, host, tool, agent, 'L6 成员会话（只读工具既有放行）')
      } else {
        // 既有成员门禁口径：放行 + next 1 次 + 提醒说明委派/subagent（见 tests/member-gate-deny.test.js）。
        await assertReminded(t, host, tool, agent, 'L6 成员会话（既有成员门禁口径）', /(委派|subagent)/)
      }
    })
  }
})

test('L7 turn 边界：上一 turn 的 team_task_create 不算本轮证据，本轮仍然提醒', async (t) => {
  const CASES = [
    {
      label: 'create 在前一 turn，随后 turn/start 开新 turn',
      events: [runEvent('on'), turnStart(1), toolCall('team_task_create'), turnStart(2)],
    },
    {
      label: '本 turn 只有非委派类 tool/call',
      events: [runEvent('on'), turnStart(1), toolCall('team_task_create'), turnStart(2), toolCall('skill')],
    },
  ]
  for (const { label, events } of CASES) {
    await t.test(label, async () => {
      const host = leadHost()
      apply(host.ctx)
      await assertReminded(t, host, 'bash', leadAgent(events), `L7 ${label}`, /team_task_create[\s\S]*subagent/)
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
  notices: [],
  inject(message) { this.notices.push(message) },
})

test('L10 subagent 会话头 delegationDepth=1：取证 read 不被 Lead 门禁误伤（放行）', async (t) => {
  // Lead 派出的取证据子代理：无 membership（tryMembership 返回 undefined），会话头 delegationDepth=1；
  // 判据：next 恰好 1 次、decisions 无 kind==='deny'、返回值 kind==='allow'（来自 next()）。
  const host = leadHost()
  apply(host.ctx)
  await assertAllowed(t, host, 'read', subAgentWithHeader(1), 'L10 subagent header.delegationDepth=1')
})

test('L10b 反向对照：同一 fixture header.delegationDepth=0（Lead）→ read 放行并提醒一次', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  await assertReminded(t, host, 'read', subAgentWithHeader(0), 'L10b Lead 会话头 delegationDepth=0', /team_task_create[\s\S]*subagent/)
})

test('L10c 会话头缺失按 delegationDepth=0 处理（根会话）→ read 放行并提醒一次', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = {
    id: 'sub-2',
    session: { snapshotEvents: () => [runEvent('on'), turnStart(1)] },
    notices: [],
    inject(message) { this.notices.push(message) },
  }
  await assertReminded(t, host, 'read', agent, 'L10c header 缺失按 depth=0 提醒', /team_task_create[\s\S]*subagent/)
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

test('L11 本轮没有派发：取证工具逐个放行 + 提醒一次（含 web_fetch / web_search）', async (t) => {
  for (const tool of EVIDENCE_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('team_task_list')])
      await assertReminded(t, host, tool, agent, `L11 无派发（${tool}）`, /team_task_create[\s\S]*subagent/)
    })
  }
})

test('L12 本轮已 subagent：Lead 取证放行且不提醒（判据只看本轮是否已派发）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('spawn_teammate'), memberEvent('m1')])
  await assertAllowed(t, host, 'bash', agent, 'L12 本轮已派发且有 running 成员')
})

test('L13 interrupt_agent 不参与判定：本轮已派发后中断成员再取证，放行且不提醒', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([
    runEvent('on'),
    turnStart(1),
    toolCall('team_task_create'),
    toolCall('spawn_teammate'),
    memberEvent('m1'),
    taskEvent('t1', 'in_progress', 'm1'),
    toolCall('interrupt_agent'),
  ])
  await assertAllowed(t, host, 'grep', agent, 'L13 中断成员后立刻取证（本轮已派发）')
  // 反例（断言不是恒真）：同一夹具把本轮的 subagent 去掉 → 判据成立 → 放行 + 提醒一次，而不是拒绝。
  const bareAgent = leadAgent([
    runEvent('on'),
    turnStart(1),
    toolCall('team_task_create'),
    memberEvent('m1'),
    toolCall('interrupt_agent'),
  ])
  const bare = await gateOutcome(host, execOf('grep', bareAgent))
  assert.equal(bare.threw, undefined, `L13 无派发对照：门禁处理器不得抛异常，实际抛出：${bare.threw instanceof Error ? bare.threw.message : String(bare.threw)}`)
  assert.equal(bare.nextCalls, 1, `L13 无派发对照：必须放行（next 恰好一次），实际 ${bare.nextCalls} 次`)
  assert.equal(bare.decisions.filter((decision) => decision?.kind === 'deny').length, 0, `L13 无派发对照：不得 deny，实际 ${stringify(bare.decisions)}`)
  assert.equal(bareAgent.notices.length, 1, `L13 无派发对照：必须恰好投递一条提醒，实际 ${bareAgent.notices.length} 条`)
})

test('L14 中断成员后重新 spawn 派发：同一轮立即恢复放行（不得永久锁死）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([
    runEvent('on'),
    turnStart(1),
    toolCall('spawn_teammate'),
    memberEvent('m1'),
    toolCall('interrupt_agent'),
    toolCall('team_task_create'),
    toolCall('spawn_teammate'),
  ])
  await assertAllowed(t, host, 'bash', agent, 'L14 中断后重新派发')
})

test('L15 running 成员判据已移除：成员 active / failed / 任务全部 completed 都不参与判定（本轮未派发一律提醒一次，本轮已派发一律不提醒）', async (t) => {
  const CASES = [
    {
      label: '上一 turn spawn 的 active 成员仍有 in_progress 任务',
      events: [runEvent('on'), turnStart(1), memberEvent('m1'), taskEvent('t1', 'in_progress', 'm1'), turnStart(2)],
    },
    {
      label: '成员 phase=failed（硬终态）',
      events: [runEvent('on'), turnStart(1), memberEvent('m1', 'failed'), turnStart(2)],
    },
    {
      label: '成员 active 但名下任务全部 completed（finishedMembers 判定已完成）',
      events: [runEvent('on'), turnStart(1), memberEvent('m1'), taskEvent('t1', 'completed', 'm1'), turnStart(2)],
    },
  ]
  for (const { label, events } of CASES) {
    await t.test(`${label}（本轮未派发）`, async () => {
      const host = leadHost()
      apply(host.ctx)
      await assertReminded(t, host, 'read', leadAgent(events), `L15 ${label} 未派发`, /team_task_create[\s\S]*subagent/)
    })
    await t.test(`${label}（本轮已派发）`, async () => {
      const host = leadHost()
      apply(host.ctx)
      await assertAllowed(t, host, 'read', leadAgent([...events, toolCall('spawn_teammate')]), `L15 ${label} 已派发`)
    })
  }
})

test('L16 nested 模式 Lead 直派 subagent / workflow 也算已派发：取证放行', async (t) => {
  for (const dispatch of ['subagent', 'subagent_fork', 'workflow']) {
    await t.test(dispatch, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall(dispatch)])
      await assertAllowed(t, host, 'bash', agent, `L16 本轮已派发 ${dispatch}`)
    })
  }
})

test('L17 本轮没有派发：实现工具逐个放行 + 提醒一次（write / edit / apply_patch / str_replace_editor）', async (t) => {
  // 覆盖的就是「Lead 被提醒 bash 之后转而自己写文件」这条绕行：判据与取证类完全一致。
  for (const tool of IMPLEMENTATION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create')])
      await assertReminded(t, host, tool, agent, `L17 Lead 只建了看板就下场写文件（${tool}）`, /team_task_create[\s\S]*subagent/)
    })
  }
})

test('L18 实现工具的提醒正文：前缀 [team-gate] 提醒、点名「实现工具「write」」与「实现与取证都必须委派」，工具照常执行', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1)])
  const { decisions, threw, nextCalls } = await gateOutcome(host, execOf('write', agent))
  assert.equal(threw, undefined, `L18 / write：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
  assert.equal(decisions.filter((decision) => decision?.kind === 'deny').length, 0, `L18 / write：不得返回任何 deny，实际 ${stringify(decisions)}`)
  assert.equal(nextCalls, 1, `L18 / write：提醒路径必须调用 next（工具真正执行），实际 ${nextCalls} 次`)
  assert.equal(agent.notices.length, 1, `L18 / write：必须恰好投递一条提醒，实际 ${agent.notices.length} 条`)
  const text = agent.notices[0]?.content?.[0]?.text
  assert.match(text, /^\[team-gate\] 提醒：/, `L18 / write：提醒前缀必须是 [team-gate] 提醒：，实际「${text}」`)
  assert.match(text, /本轮还没有派发成员/, `L18 / write：必须说明本轮尚未派发，实际「${text}」`)
  assert.match(text, /实现工具「write」/, `L18 / write：必须把它归为实现工具并点名工具名，实际「${text}」`)
  assert.match(text, /仍会照常执行/, `L18 / write：必须说明工具照常执行，实际「${text}」`)
  assert.match(text, /实现与取证都必须委派/, `L18 / write：必须说明实现与取证都必须委派，实际「${text}」`)
  assert.match(text, /team_task_create[\s\S]*subagent/, `L18 / write：必须给出正确做法，实际「${text}」`)
  assert.match(text, /新的 turn 开始后会再提醒一次/, `L18 / write：必须说明按轮刷新，实际「${text}」`)
  assert.deepEqual(host.warnings, [], `L18 / write：提醒投递不属于 fail-open，不得 warn，实际：${JSON.stringify(host.warnings)}`)
})

test('L19 本轮已 subagent：Lead 的 write 放行且不提醒（门禁判「本轮是否已派出活」，不是一律封写）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('spawn_teammate'), memberEvent('m1')])
  await assertAllowed(t, host, 'write', agent, 'L19 本轮已派发')
})

test('L20 Lead 派出的子代理（header.delegationDepth=1）实现工具放行：委派后的实现必须真能落地', async (t) => {
  for (const tool of IMPLEMENTATION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      await assertAllowed(t, host, tool, subAgentWithHeader(1), `L20 子代理会话头 delegationDepth=1（${tool}）`)
    })
  }
})

test('L21 成员会话（nested）的实现工具不被 Lead 集合卷入拒绝：沿用既有成员门禁（放行 + 提醒一次）', async (t) => {
  for (const tool of IMPLEMENTATION_TOOLS) {
    await t.test(tool, async () => {
      const host = memberHost()
      apply(host.ctx)
      await assertReminded(t, host, tool, teammateAgent([runEvent('on')]), `L21 成员会话沿用成员门禁口径（${tool}）`, /(委派|subagent)/)
    })
  }
})

test('L22 本轮没有派发：执行类工具逐个放行 + 提醒一次（run_code / terminal_open / terminal_read / terminal_send / terminal_signal）', async (t) => {
  // 覆盖的就是「Lead 被提醒 bash / write 之后改用 run_code 或持久终端把活做掉」这条绕行：判据与取证类、实现类完全一致。
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create')])
      await assertReminded(t, host, tool, agent, `L22 Lead 只建了看板就下场执行（${tool}）`, /team_task_create[\s\S]*subagent/)
    })
  }
})

test('L23 执行类工具的提醒正文：前缀 [team-gate] 提醒、逐个点名「执行工具「<tool>」」与等价通道说明', async (t) => {
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1)])
      const { decisions, threw, nextCalls } = await gateOutcome(host, execOf(tool, agent))
      assert.equal(threw, undefined, `L23 / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
      assert.equal(decisions.filter((decision) => decision?.kind === 'deny').length, 0, `L23 / ${tool}：不得返回任何 deny，实际 ${stringify(decisions)}`)
      assert.equal(nextCalls, 1, `L23 / ${tool}：提醒路径必须调用 next（工具真正执行），实际 ${nextCalls} 次`)
      assert.equal(agent.notices.length, 1, `L23 / ${tool}：必须恰好投递一条提醒，实际 ${agent.notices.length} 条`)
      const text = agent.notices[0]?.content?.[0]?.text
      assert.match(text, new RegExp(`^\\[team-gate\\] 提醒：本轮还没有派发成员，执行工具「${tool}」`), `L23 / ${tool}：必须归类为「执行工具」并点名工具名，实际「${text}」`)
      assert.match(text, /执行工具本身就是取证与实现的等价通道/, `L23 / ${tool}：必须说明它是取证与实现的等价通道，实际「${text}」`)
      assert.match(text, /team_task_create[\s\S]*subagent/, `L23 / ${tool}：必须给出正确做法，实际「${text}」`)
      assert.deepEqual(host.warnings, [], `L23 / ${tool}：提醒投递不属于 fail-open，不得 warn，实际：${JSON.stringify(host.warnings)}`)
    })
  }
})

test('L24 本轮已 subagent：Lead 的执行类工具放行且不提醒（门禁判「本轮是否已派出活」，不是一律提醒执行）', async (t) => {
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('spawn_teammate'), memberEvent('m1')])
      await assertAllowed(t, host, tool, agent, `L24 本轮已派发（${tool}）`)
    })
  }
})

test('L25 成员会话（nested）的执行类工具不被 Lead 集合卷入拒绝：沿用既有成员门禁（放行 + 提醒一次）', async (t) => {
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = memberHost()
      apply(host.ctx)
      await assertReminded(t, host, tool, teammateAgent([runEvent('on')]), `L25 成员会话沿用成员门禁口径（${tool}）`, /(委派|subagent)/)
    })
  }
})

test('L26 Lead 派出的子代理（header.delegationDepth=1）执行类工具放行：委派后的执行必须真能落地', async (t) => {
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      await assertAllowed(t, host, tool, subAgentWithHeader(1), `L26 子代理会话头 delegationDepth=1（${tool}）`)
    })
  }
})
