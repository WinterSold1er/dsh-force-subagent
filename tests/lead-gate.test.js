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
 *   Lead 硬拦集合 = 三类并集（取证 8 + 实现 4 + 执行 5 = 17），同一判据；
 *   拒绝条件 = Lead 会话（ctx.get('agentTeams').tryMembership(exec.agent) 未命中）
 *     + force-subagent 启用（Lead 会话最后一次 command/run（using-agent-team）args 非 off）
 *     + 被调工具 ∈ 三类并集
 *     + 本 turn（事件序列中最后一个 turn/start 之后）既没有委派类 tool/call（spawn_teammate / subagent 系列 / workflow），
 *       也没有 running 成员（team/member 最后快照 phase !== 'failed' 且未被 finishedMembers 判定完成）；
 *     + 或本 turn 的 interrupt_agent 发生在最后一次委派之后 → 同样拒绝（成员已不可用）；
 *   编排类工具（team_task_* / spawn_teammate / send_message / wait_agent / list_agents / interrupt_agent）不受影响；
 *   单靠 team_task_create 不再放行取证工具；
 *   其余全部放行（返回值必须是 next() 的结果）；成员会话（tryMembership 命中）继续走既有成员门禁分支；
 *   fail-open：读取会话事件（snapshotEvents）抛错 → 放行且不抛异常。
 * 断言口径：每条用例都核对 next 是否被调用与调用次数；硬门禁用例核对 deny 返回值与 reason 正文
 *   （必须点名被拒工具名与唯一出路 team_task_create / spawn_teammate）且不投递提醒；放行用例核对
 *   next 恰好一次且返回值来自 next()。
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

/** Lead 取证硬门禁判据：不抛异常、恰好一条 deny、next 未被调用、reason 点名被拒工具与唯一出路，且不投递提醒。 */
async function assertDenied(t, host, tool, agent, label, hint = /team_task_create[\s\S]*spawn_teammate/) {
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
  const denials = decisions.filter((decision) => decision?.kind === 'deny')
  assert.equal(denials.length, 1, `${label} / ${tool}：必须恰好返回一条 deny，实际 ${stringify(decisions)}`)
  assert.equal(nextCalls, 0, `${label} / ${tool}：被拒路径不得调用 next（工具不能真的执行），实际 ${nextCalls} 次`)
  const reason = denials[0]?.reason
  assert.equal(typeof reason, 'string', `${label} / ${tool}：deny 必须给出字符串 reason，实际 ${stringify(denials[0])}`)
  assert.ok(reason.length > 0, `${label} / ${tool}：reason 不得为空串`)
  assert.match(reason, new RegExp(tool), `${label} / ${tool}：reason 必须点名被拒工具名「${tool}」，实际为「${reason}」`)
  assert.match(reason, hint, `${label} / ${tool}：reason 必须给出唯一出路（命中「${hint}」），实际为「${reason}」`)
  assert.equal(agent?.notices?.length ?? 0, 0, `${label} / ${tool}：硬门禁不再投递提醒，实际 ${agent?.notices?.length ?? 0} 条`)
  const failOpen = host.warnings.filter((message) => /门禁未生效|放行/.test(message))
  assert.equal(failOpen.length, 0, `${label} / ${tool}：判据成立而工具被拒，不属于 fail-open，不得 warn，实际：${host.warnings.join(' | ')}`)
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

test('L1 启用 + Lead + 本轮无派发无成员：bash 被拒（reason 点名 bash 与 team_task_create / spawn_teammate）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1)])
  await assertDenied(t, host, 'bash', agent, 'L1 Lead 已启用且本轮无派发无成员')
})

test('L2 启用 + Lead + 本轮只有 team_task_create（没有派发、没有 running 成员）：bash 被拒', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('team_task_get')])
  await assertDenied(t, host, 'bash', agent, 'L2 Lead 只建了看板就下场取证')
})

test('L3 EVIDENCE_TOOLS 全表同规则：Lead 本轮无派发无成员时逐个被拒', async (t) => {
  for (const tool of EVIDENCE_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1)])
      await assertDenied(t, host, tool, agent, `L3 Lead 已启用且本轮无派发无成员（${tool}）`)
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

test('L7 turn 边界：上一 turn 的 team_task_create 不算本轮证据，仍拒绝', async (t) => {
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

test('L10b 反向对照：同一 fixture header.delegationDepth=0（Lead）→ read 被拒（deny，不投递提醒）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  await assertDenied(t, host, 'read', subAgentWithHeader(0), 'L10b Lead 会话头 delegationDepth=0')
})

test('L10c 会话头缺失按 delegationDepth=0 处理（根会话）→ read 被拒', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = {
    id: 'sub-2',
    session: { snapshotEvents: () => [runEvent('on'), turnStart(1)] },
    notices: [],
    inject(message) { this.notices.push(message) },
  }
  await assertDenied(t, host, 'read', agent, 'L10c header 缺失按 depth=0 拒绝')
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

test('L11 本轮既没有派发也没有 running 成员：取证工具逐个被拒（含 web_fetch / web_search）', async (t) => {
  for (const tool of EVIDENCE_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('team_task_list')])
      await assertDenied(t, host, tool, agent, `L11 无派发无成员（${tool}）`)
    })
  }
})

test('L12 本轮已 spawn_teammate 且成员在跑：Lead 取证放行（next 恰好 1 次、无提醒）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('spawn_teammate'), memberEvent('m1')])
  await assertAllowed(t, host, 'bash', agent, 'L12 本轮已派发且有 running 成员')
})

test('L13 本轮 interrupt_agent 中断成员后立即取证：被拒（reason 点名 interrupt_agent 与新成员出路）', async (t) => {
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
  await assertDenied(t, host, 'grep', agent, 'L13 中断成员后立刻取证')
  const gate = await gateOutcome(host, execOf('grep', leadAgent([
    runEvent('on'),
    turnStart(1),
    toolCall('spawn_teammate'),
    memberEvent('m1'),
    toolCall('interrupt_agent'),
  ])))
  const deny = gate.decisions.find((decision) => decision?.kind === 'deny')
  assert.ok(deny, 'L13：必须返回 deny')
  assert.match(deny.reason, /interrupt_agent/, 'L13：reason 必须点名本轮 interrupt_agent')
  assert.match(deny.reason, /新活必须 spawn 新成员/, 'L13：reason 必须给出唯一出路（新成员承接）')
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

test('L15 running 成员判据：active 且名下有在办任务 → 放行；failed / 任务全部 completed → 不算 running', async (t) => {
  const CASES = [
    {
      label: '上一 turn spawn 的 active 成员仍有 in_progress 任务',
      events: [runEvent('on'), turnStart(1), memberEvent('m1'), taskEvent('t1', 'in_progress', 'm1'), turnStart(2)],
      expected: 'allow',
    },
    {
      label: '成员 phase=failed（硬终态）',
      events: [runEvent('on'), turnStart(1), memberEvent('m1', 'failed'), turnStart(2)],
      expected: 'deny',
    },
    {
      label: '成员 active 但名下任务全部 completed（finishedMembers 判定已完成）',
      events: [runEvent('on'), turnStart(1), memberEvent('m1'), taskEvent('t1', 'completed', 'm1'), turnStart(2)],
      expected: 'deny',
    },
  ]
  for (const { label, events, expected } of CASES) {
    await t.test(label, async () => {
      const host = leadHost()
      apply(host.ctx)
      if (expected === 'allow') {
        await assertAllowed(t, host, 'read', leadAgent(events), `L15 ${label}`)
      } else {
        await assertDenied(t, host, 'read', leadAgent(events), `L15 ${label}`)
      }
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

test('L17 本轮既没有派发也没有 running 成员：实现工具逐个被拒（write / edit / apply_patch / str_replace_editor）', async (t) => {
  // 封的就是「Lead 被拒 bash 之后转而自己写文件」这条绕行：判据与取证类完全一致。
  for (const tool of IMPLEMENTATION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create')])
      await assertDenied(t, host, tool, agent, `L17 Lead 只建了看板就下场写文件（${tool}）`)
    })
  }
})

test('L18 实现工具的 deny 正文：前缀 [team-gate] LEAD_EVIDENCE_DENIED:、点名「实现工具「write」」与「实现与取证都必须委派」', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1)])
  const { decisions, threw, nextCalls } = await gateOutcome(host, execOf('write', agent))
  assert.equal(threw, undefined, `L18 / write：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
  const denials = decisions.filter((decision) => decision?.kind === 'deny')
  assert.equal(denials.length, 1, `L18 / write：必须恰好一条 deny，实际 ${stringify(decisions)}`)
  assert.equal(nextCalls, 0, `L18 / write：硬拒路径不得调用 next（工具不得真正执行），实际 ${nextCalls} 次`)
  const reason = denials[0]?.reason
  assert.equal(typeof reason, 'string', `L18 / write：deny 必须给出字符串 reason，实际 ${stringify(denials[0])}`)
  assert.match(reason, /^\[team-gate\] LEAD_EVIDENCE_DENIED:/, `L18 / write：reason 前缀必须是 [team-gate] LEAD_EVIDENCE_DENIED:，实际「${reason}」`)
  assert.match(reason, /实现工具「write」/, `L18 / write：reason 必须把它归为实现工具，实际「${reason}」`)
  assert.match(reason, /实现与取证都必须委派/, `L18 / write：reason 必须说明实现与取证都必须委派，实际「${reason}」`)
  assert.match(reason, /team_task_create[\s\S]*spawn_teammate/, `L18 / write：reason 必须给出唯一出路，实际「${reason}」`)
  assert.equal(agent.notices.length, 0, `L18 / write：硬拒不得同时投递提醒，实际 ${agent.notices.length} 条`)
})

test('L19 本轮已 spawn_teammate 且有 running 成员：Lead 的 write 放行（门禁判「本轮是否已派出活」，不是一律封写）', async (t) => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('spawn_teammate'), memberEvent('m1')])
  await assertAllowed(t, host, 'write', agent, 'L19 本轮已派发且有 running 成员')
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

test('L22 本轮既没有派发也没有 running 成员：执行类工具逐个被拒（run_code / terminal_open / terminal_read / terminal_send / terminal_signal）', async (t) => {
  // 封的就是「Lead 被拒 bash / write 之后改用 run_code 或持久终端把活做掉」这条绕行：判据与取证类、实现类完全一致。
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create')])
      await assertDenied(t, host, tool, agent, `L22 Lead 只建了看板就下场执行（${tool}）`)
    })
  }
})

test('L23 执行类工具的 deny 正文：前缀 [team-gate] LEAD_EVIDENCE_DENIED:、逐个点名「执行工具「<tool>」」与「实现与取证都必须委派」', async (t) => {
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1)])
      const { decisions, threw, nextCalls } = await gateOutcome(host, execOf(tool, agent))
      assert.equal(threw, undefined, `L23 / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
      const denials = decisions.filter((decision) => decision?.kind === 'deny')
      assert.equal(denials.length, 1, `L23 / ${tool}：必须恰好一条 deny，实际 ${stringify(decisions)}`)
      assert.equal(nextCalls, 0, `L23 / ${tool}：硬拒路径不得调用 next（工具不得真正执行），实际 ${nextCalls} 次`)
      const reason = denials[0]?.reason
      assert.equal(typeof reason, 'string', `L23 / ${tool}：deny 必须给出字符串 reason，实际 ${stringify(denials[0])}`)
      assert.match(reason, /^\[team-gate\] LEAD_EVIDENCE_DENIED:/, `L23 / ${tool}：reason 前缀必须是 [team-gate] LEAD_EVIDENCE_DENIED:，实际「${reason}」`)
      assert.match(reason, new RegExp(`执行工具「${tool}」`), `L23 / ${tool}：reason 必须把它归为执行工具并点名工具名，实际「${reason}」`)
      assert.match(reason, /实现与取证都必须委派/, `L23 / ${tool}：reason 必须说明实现与取证都必须委派，实际「${reason}」`)
      assert.match(reason, /team_task_create[\s\S]*spawn_teammate/, `L23 / ${tool}：reason 必须给出唯一出路，实际「${reason}」`)
      assert.equal(agent.notices.length, 0, `L23 / ${tool}：硬拒不得同时投递提醒，实际 ${agent.notices.length} 条`)
      assert.deepEqual(host.warnings, [], `L23 / ${tool}：判据成立而工具被拒不属于 fail-open，不得 warn，实际：${JSON.stringify(host.warnings)}`)
    })
  }
})

test('L24 本轮已 spawn_teammate 且有 running 成员：Lead 的执行类工具放行（门禁判「本轮是否已派出活」，不是一律封执行）', async (t) => {
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('spawn_teammate'), memberEvent('m1')])
      await assertAllowed(t, host, tool, agent, `L24 本轮已派发且有 running 成员（${tool}）`)
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
