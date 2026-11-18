/**
 * dsh-force-subagent「已完成成员不再接活」门禁测试（task-4 契约 / task-5 用例；task-22 起为软门禁）。
 *
 * 契约（与 task-4 一致）：
 * - team 状态来源 = Lead(root) 会话事件，真实宿主形状（已核对 agent-team 源码）：
 *   types.ts:230 `'team/member': { version: 2, teamId, member: TeamMemberSnapshot }`（id / name / role / phase）
 *   journal.ts:9 可变事件只有 'team/member' | 'team/task'；task-board.ts:208 每次变更 append 一条
 *   `'team/task': { version: 2, teamId, task }`，同一 task 会有多条快照，必须以 task.id 的最后一条为准。
 *   task.status ∈ pending | in_progress | completed | deleted；reopen 会清 ownerId（task-board.ts:170）。
 * - isFinished(成员) 判定为「粘性」：该成员被指派过任务（历史 ownerId 命中 ≥ 1），且它名下没有任何
 *   仍活跃（pending / in_progress 且 ownerId 仍是它）的任务 —— 即它的活已经干完（completed / deleted）。
 *   粘性是必须的：reopen 只重置任务并清 owner（宿主语义），若按「当前名下快照全 completed」判定，
 *   reopen 会让已完成成员重新变成「未完成」，task-5 用例 7 与 task-4 第 3 条（reopen 后仍由 claim 拦）就不成立。
 *   零任务成员（刚 spawn）NOT finished。
 * - 软门禁形态（task-22）：不返回 deny，处理器调用 next() 放行，同时向调用方会话 inject 一条 notice；
 *   notice 正文前缀 `[team-gate] TEAM_MEMBER_FINISHED:`，文案给出解法（subagent 新建成员）。同一会话同一成员只投递一次。
 * - 拦（改为提醒）send_message({ agent }) 与 team_task_update(action=claim 调用者自身 / action=reassign owner)；
 *   rc.2 的 send_message 参数是 { agent: 成员名, message }（旧的 target / agent_id 已删除）；
 *   reopen 不提醒；非成员 target 不提醒；读不到 team 状态 → fail-open 放行 + warn 且不提醒。
 * - 门禁只在 caps.board 档启用（有 team_task_create）：替身必须同时提供 tools 服务与本步 toolSet，
 *   否则 rc.2 契约按 standard 降级，本门禁整体停用。
 * - interrupt_agent 不在拦的范围：Lead 收敛已完成成员靠它（见 flat 提示词与 mode-flat.test.js B2）。
 *
 * 运行：node --test tests/member-finished-gate.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'
const PREFIX = '[team-gate] TEAM_MEMBER_FINISHED:'

/** Lead 开启记录：门禁全部只在 /using-agent-team 开启时生效。 */
const runEvent = (args = 'on') => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const turnStart = (turn = 1) => ({ type: 'turn/start', data: { turn } })
const toolCall = (name, callId) => ({ type: 'tool/call', data: { name, callId } })

/** 真实 team/member 事件形状（types.ts:230）。 */
const memberEvent = (id, name) => ({
  type: 'team/member',
  data: { version: 2, teamId: 'team-1', member: { id, name, role: 'teammate', phase: 'active' } },
})

/** 真实 team/task 快照事件形状（task-board.ts:203-208：ownerId 可被 reopen 清除）。 */
const taskEvent = (id, status, revision = 1, ownerId) => ({
  type: 'team/task',
  data: {
    version: 2,
    teamId: 'team-1',
    task: {
      id,
      subject: `task ${id}`,
      status,
      revision,
      blockedBy: [],
      ...(ownerId === undefined ? {} : { ownerId }),
    },
  },
})

/** 与 tests/gate-observability.test.js 同一套宿主替身：systemPrompt / commands 必须给到位，否则 apply 自身的服务未就绪告警会污染 warn 计数。 */
function createSystemPrompt() {
  const sections = []
  return { sections, section: (definition) => { sections.push(definition) } }
}

function createCommands() {
  const registered = []
  return { registered, register: (definition) => { registered.push(definition) } }
}

/**
 * rc.2 team 档工具面：section / 门禁按本步 toolSet 探测真实工具。
 * 有 team_task_create 才会启用「已完成成员」门禁（caps.board），缺了它整条链路按 standard 停用。
 */
const TOOL_SET = Object.freeze({ step: 'test' })
const TEAM_TOOL_NAMES = [
  'subagent', 'subagent_fork', 'workflow',
  'team_task_create', 'team_task_update', 'team_task_list', 'interrupt_agent',
  'send_message', 'list_agents', 'wait_agent', 'todo_write',
  'read', 'grep', 'glob', 'write', 'edit', 'bash',
]
const createTools = () => ({ definitions: () => TEAM_TOOL_NAMES.map((name) => ({ name })) })

function createHost({ agentTeams } = {}) {
  const onCalls = []
  const warnings = []
  const ctx = {
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: ctx.fiber ?? { uid: 'test-fiber' },
      settings: ctx.settings ?? { configure: () => () => {} },
      logger: ctx.logger,
    }),
    logger: { warn: (message) => { warnings.push(message) } },
    get: (service) => (
      service === 'systemPrompt' ? createSystemPrompt()
        : service === 'commands' ? createCommands()
          : service === 'agentTeams' ? agentTeams
            : service === 'tools' ? createTools()
              : undefined
    ),
    on: (...args) => {
      onCalls.push(args)
    },
  }
  return { ctx, onCalls, warnings }
}

/** 成员名 → member.id 由 Lead 会话的 team/member 事件给出；Lead 行是宿主合成（projection.ts:344），不在事件里。 */
const leadEvents = (...events) => ({ snapshotEvents: () => [runEvent('on'), ...events] })

/**
 * 宿主身份事实（roster.ts:89-104）：teammate 的 TeamMembership.id 是 **Lead(root) 会话 id**，
 * 不是成员自己的 id；成员自己的 id === 其 Agent.id（`members.find(candidate => candidate.id === agent.id)`）。
 * 所以替身必须照此建：membership.id 用 Lead id，成员 id 挂在 agent.id 上。
 */
const LEAD_ID = 'lead-1'

const membershipOf = ({ role = 'teammate', name = 'worker-1', events = [] } = {}) => ({
  role,
  id: LEAD_ID,
  name,
  root: { session: leadEvents(...events) },
})

const agentOf = (membership, ownEvents = [], id = membership.role === 'lead' ? LEAD_ID : 'm1') => ({
  id,
  session: { snapshotEvents: () => ownEvents },
  membership,
  notices: [],
  inject(message) { this.notices.push(message) },
})

const agentTeamsService = () => ({ tryMembership: (agent) => agent?.membership ?? undefined })

const hostFor = ({ mode = 'flat', agentTeams = agentTeamsService() } = {}) => {
  const host = createHost({ agentTeams })
  apply(host.ctx, { mode })
  return host
}

const gateHandlers = (host) =>
  host.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)

const execOf = (name, agent, args = {}) => ({
  callId: `call-${name}`,
  name,
  arguments: args,
  agent,
  toolSet: TOOL_SET,
  signal: new AbortController().signal,
})

/** 调用真实注册的处理器链（不是 mock 自身）；next 计数用于判定拦截是否真的生效。 */
async function gateOutcome(host, exec) {
  const handlers = gateHandlers(host)
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
  }
  const decisions = []
  let threw
  try {
    for (const handler of handlers) decisions.push(await handler(exec, next))
  } catch (error) {
    threw = error
  }
  return {
    decisions,
    threw,
    handlerCount: handlers.length,
    nextCalls,
    warnings: host.warnings,
    notices: exec?.agent?.notices ?? [],
  }
}

const stringify = (value) => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const finishedDenials = (decisions) =>
  decisions.filter(
    (decision) => decision?.kind === 'deny' && typeof decision.reason === 'string' && decision.reason.startsWith(PREFIX),
  )

const finishedReminders = (notices) =>
  (notices ?? []).filter(
    (notice) => typeof notice?.content?.[0]?.text === 'string' && notice.content[0].text.startsWith(PREFIX),
  )

/** 软门禁判据（task-22 口径）：工具调用放行（每处理器 next 一次）、无带前缀的 deny，且恰好投递一条前缀 + 解法文案的 notice。 */
const assertFinishedReminded = ({ threw, decisions, nextCalls, handlerCount, notices, tool, label }) => {
  assert.equal(
    threw,
    undefined,
    `${label} / ${tool}：门禁处理器不得抛异常给调用方，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`,
  )
  assert.equal(
    finishedDenials(decisions).length,
    0,
    `${label} / ${tool}：软门禁不得返回前缀为「${PREFIX}」的 deny，处理器返回：${stringify(decisions)}`,
  )
  assert.equal(
    nextCalls,
    handlerCount,
    `${label} / ${tool}：放行路径每个处理器必须恰好调用 next 一次，实际 ${nextCalls} 次（处理器 ${handlerCount} 个）`,
  )
  const reminders = finishedReminders(notices)
  assert.equal(
    reminders.length,
    1,
    `${label} / ${tool}：必须恰好投递一条前缀为「${PREFIX}」的提醒，实际 ${reminders.length} 条：${stringify(notices)}`,
  )
  const text = reminders[0].content[0].text
  assert.match(
    text,
    /subagent|新建成员|新成员/,
    `${label} / ${tool}：提醒必须给出解法（spawn 新成员承接），实际为「${text}」`,
  )
  assert.equal(
    reminders[0]?.source?.form,
    'notice',
    `${label} / ${tool}：提醒必须走 notice 通道，实际 ${stringify(reminders[0]?.source)}`,
  )
}

/** allow 侧实质断言：没有该门禁的 deny，且每个处理器都把控制权交回 next 恰好一次。 */
const assertAllowed = ({ threw, decisions, nextCalls, handlerCount, notices, tool, label }) => {
  assert.equal(
    threw,
    undefined,
    `${label} / ${tool}：门禁处理器不得抛异常给调用方，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`,
  )
  const denials = finishedDenials(decisions)
  assert.equal(
    denials.length,
    0,
    `${label} / ${tool}：该场景不该 deny，实际 deny：${stringify(denials)}`,
  )
  assert.equal(
    nextCalls,
    handlerCount,
    `${label} / ${tool}：放行路径每个处理器必须恰好调用 next 一次，实际 ${nextCalls} 次（处理器 ${handlerCount} 个）`,
  )
  assert.equal(notices?.length ?? 0, 0, `${label} / ${tool}：不该触发的场景不得投递提醒，实际 ${notices?.length ?? 0} 条`)
}

// 场景事件集：成员 m1 / worker-1。
const FINISHED = [memberEvent('m1', 'worker-1'), taskEvent('t1', 'completed', 2, 'm1')]
const FINISHED_DELETED = [memberEvent('m1', 'worker-1'), taskEvent('t1', 'deleted', 3, 'm1')]
const MIXED = [
  memberEvent('m1', 'worker-1'),
  taskEvent('t1', 'completed', 2, 'm1'),
  taskEvent('t2', 'in_progress', 2, 'm1'),
]
const SPAWNED_NO_TASKS = [memberEvent('m1', 'worker-1')]
const REOPENED = [
  memberEvent('m1', 'worker-1'),
  taskEvent('t1', 'completed', 2, 'm1'),
  taskEvent('t1', 'pending', 3),
]

const leadSender = (events) => agentOf(membershipOf({ role: 'lead', name: 'lead', events }))
const memberSender = (events) => agentOf(membershipOf({ name: 'worker-2', events }), [], 'm2')

test('用例 1：成员 A 名下 task 已 completed → send_message({ agent: A }) 放行并提醒（文案给出新成员解法）', async (t) => {
  for (const mode of ['flat', 'nested']) {
    await t.test(`${mode} / Lead 发给已完成成员`, async () => {
      const host = hostFor({ mode })
      const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
        host,
        execOf('send_message', leadSender(FINISHED), { agent: 'worker-1', message: '再改一轮' }),
      )
      assertFinishedReminded({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: `${mode} 已完成成员 target` })
    })
  }
  await t.test('flat / 成员发给已完成成员（任何 sender 都拦）', async () => {
    const host = hostFor({ mode: 'flat' })
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
      host,
      execOf('send_message', memberSender(FINISHED), { agent: 'worker-1', message: '帮我接着做' }),
    )
    assertFinishedReminded({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: 'flat 成员 sender' })
  })
})

test('用例 2：completed + in_progress 同时存在 → 不算 finished，放行', async (t) => {
  for (const mode of ['flat', 'nested']) {
    await t.test(mode, async () => {
      const host = hostFor({ mode })
      const agent = mode === 'flat' ? memberSender(MIXED) : leadSender(MIXED)
      const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
        host,
        execOf('send_message', agent, { agent: 'worker-1', message: '继续' }),
      )
      assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: '名下仍有活跃任务' })
    })
  }
})

test('用例 3：成员 A 零任务（刚 spawn 未派活）→ 放行', async () => {
  const host = hostFor({ mode: 'flat' })
  const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
    host,
    execOf('send_message', leadSender(SPAWNED_NO_TASKS), { agent: 'worker-1', message: '给你派活' }),
  )
  assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: '零任务成员' })
})

test('用例 4：成员 A 任务已 deleted → 视为 finished，放行并提醒', async () => {
  const host = hostFor({ mode: 'flat' })
  const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
    host,
    execOf('send_message', leadSender(FINISHED_DELETED), { agent: 'worker-1', message: '补一个改动' }),
  )
  assertFinishedReminded({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: 'deleted 任务' })
})

test('用例 5：team_task_update claim —— 已完成成员自身放行并提醒，未完成成员放行', async (t) => {
  for (const mode of ['flat', 'nested']) {
    await t.test(`${mode} / 已完成成员 claim 新任务 → 放行并提醒`, async () => {
      const host = hostFor({ mode })
      const claimer = agentOf(membershipOf({ name: 'worker-1', events: FINISHED }), [], 'm1')
      const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
        host,
        execOf('team_task_update', claimer, { task_id: 't2', expected_revision: 1, action: 'claim' }),
      )
      assertFinishedReminded({ threw, decisions, nextCalls, handlerCount, notices, tool: 'team_task_update', label: `${mode} 已完成成员 claim` })
    })
  }
  for (const mode of ['flat', 'nested']) {
    await t.test(`${mode} / 未完成成员 claim 放行`, async () => {
      const host = hostFor({ mode })
      // Lead 裁决第 8 条：唯一合规解法是新成员承接同一个（被 reopen 的）任务——已完成成员 m1 在场也不拦新成员 m2。
      const events = [...REOPENED, memberEvent('m2', 'worker-2')]
      const claimer = agentOf(membershipOf({ name: 'worker-2', events }), [], 'm2')
      const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
        host,
        execOf('team_task_update', claimer, { task_id: 't1', expected_revision: 3, action: 'claim' }),
      )
      assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'team_task_update', label: `${mode} 未完成成员 claim` })
    })
  }
})

test('用例 6：team_task_update reassign 指向已完成成员 → 放行并提醒', async (t) => {
  for (const mode of ['flat', 'nested']) {
    await t.test(mode, async () => {
      const host = hostFor({ mode })
      const events = [...FINISHED, taskEvent('t2', 'pending', 1)]
      const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
        host,
        execOf('team_task_update', leadSender(events), {
          task_id: 't2',
          expected_revision: 1,
          action: 'reassign',
          owner: 'worker-1',
        }),
      )
      assertFinishedReminded({ threw, decisions, nextCalls, handlerCount, notices, tool: 'team_task_update', label: `${mode} reassign 已完成成员` })
    })
  }
})

test('用例 7：reopen 本身放行；reopen 后已完成成员再 claim 仍被提醒', async (t) => {
  await t.test('reopen 不拦', async () => {
    const host = hostFor({ mode: 'flat' })
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
      host,
      execOf('team_task_update', leadSender(FINISHED), { task_id: 't1', expected_revision: 2, action: 'reopen' }),
    )
    assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'team_task_update', label: 'reopen' })
  })
  await t.test('reopen 之后该成员 claim 仍被提醒', async () => {
    const host = hostFor({ mode: 'flat' })
    const claimer = agentOf(membershipOf({ name: 'worker-1', events: REOPENED }), [], 'm1')
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
      host,
      execOf('team_task_update', claimer, { task_id: 't1', expected_revision: 3, action: 'claim' }),
    )
    assertFinishedReminded({ threw, decisions, nextCalls, handlerCount, notices, tool: 'team_task_update', label: 'reopen 后已完成成员 claim' })
  })
})

test('用例 8：非成员 target 与 interrupt_agent 不受影响 → 放行', async (t) => {
  await t.test('target 是 Lead 自己（宿主合成行，不在 team/member 事件里）', async () => {
    const host = hostFor({ mode: 'flat' })
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
      host,
      execOf('send_message', memberSender(FINISHED), { agent: 'lead', message: '结果交回 Lead' }),
    )
    assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: 'target=lead' })
  })
  await t.test('target 不存在于 roster', async () => {
    const host = hostFor({ mode: 'flat' })
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
      host,
      execOf('send_message', leadSender(FINISHED), { agent: 'ghost-9', message: 'x' }),
    )
    assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: 'target 未知' })
  })
  await t.test('interrupt_agent 收敛已完成成员不在提醒范围', async () => {
    const host = hostFor({ mode: 'flat' })
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
      host,
      execOf('interrupt_agent', leadSender(FINISHED), { target: 'worker-1' }),
    )
    assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'interrupt_agent', label: 'interrupt 已完成成员' })
  })
  await t.test('subagent（无 membership）不受该门禁影响', async () => {
    const host = hostFor({ mode: 'flat' })
    const subagent = { session: { snapshotEvents: () => [] }, membership: undefined, header: { delegationDepth: 1 } }
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
      host,
      execOf('send_message', subagent, { agent: 'worker-1', message: 'x' }),
    )
    assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: 'subagent sender' })
  })
})

test('用例 9：读不到 team 状态 → fail-open 放行并 warn，不把异常抛给调用方', async (t) => {
  await t.test('Lead 会话事件读取抛错', async () => {
    const host = createHost({ agentTeams: agentTeamsService() })
    apply(host.ctx, { mode: 'flat' })
    const exploding = {
      session: { snapshotEvents: () => [] },
      membership: { role: 'lead', id: 'lead-1', name: 'lead', root: { session: {
        get snapshotEvents() {
          throw new Error('事件日志不可读')
        },
      } } },
    }
    const { decisions, threw, nextCalls, handlerCount, warnings, notices } = await gateOutcome(
      host,
      execOf('send_message', exploding, { agent: 'worker-1', message: 'x' }),
    )
    assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: '事件读取抛错' })
    assert.equal(warnings.length, 1, `fail-open 必须只 warn 一次，实际 ${warnings.length} 次：${warnings.join(' | ')}`)
    assert.match(warnings[0], /\[force-subagent\]/, `fail-open 必须点名插件，实际「${warnings[0]}」`)
    assert.match(warnings[0], /放行/, `fail-open 文案必须说明本次放行，实际「${warnings[0]}」`)
  })
  await t.test('agentTeams 服务缺失（无 tryMembership）', async () => {
    const host = createHost({ agentTeams: undefined })
    apply(host.ctx, { mode: 'flat' })
    const { decisions, threw, nextCalls, handlerCount, warnings, notices } = await gateOutcome(
      host,
      execOf('send_message', leadSender(FINISHED), { agent: 'worker-1', message: 'x' }),
    )
    assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: '服务缺失' })
    assert.equal(warnings.length, 1, `服务缺失必须只 warn 一次，实际 ${warnings.length} 次：${warnings.join(' | ')}`)
    assert.match(warnings[0], /agentTeams/, `warn 必须点名缺失服务，实际「${warnings[0]}」`)
  })
})

test('用例 10：原有三条门禁的「放行 + 提醒一次」不回归（相邻 wait_agent / flat 成员派子代理 / nested 白名单外）', async (t) => {
  await t.test('相邻 wait_agent 放行并提醒', async () => {
    const host = hostFor({ mode: 'flat' })
    const agent = agentOf(
      membershipOf({ name: 'worker-1', events: FINISHED }),
      [turnStart(1), toolCall('wait_agent', 'call-prev'), toolCall('team_task_list', 'call-list'), turnStart(2), toolCall('wait_agent', 'call-self')],
      'm1',
    )
    const exec = { ...execOf('wait_agent', agent), callId: 'call-current' }
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(host, exec)
    assert.equal(threw, undefined, `wait_agent 门禁不得抛异常：${threw instanceof Error ? threw.message : String(threw)}`)
    assert.equal(decisions.filter((decision) => decision?.kind === 'deny').length, 0, `相邻 wait_agent 不得 deny，处理器返回：${stringify(decisions)}`)
    assert.equal(nextCalls, handlerCount, `wait_agent 必须放行（next 每处理器一次），实际 ${nextCalls} 次`)
    assert.equal(notices.length, 1, `必须恰好投递一条 wait_agent 提醒，实际 ${notices.length} 条`)
    assert.match(notices[0]?.content?.[0]?.text ?? '', /wait_agent/, 'wait_agent 提醒应点名 wait_agent')
    assert.match(notices[0]?.content?.[0]?.text ?? '', /list_agents|team_task_list/, 'wait_agent 提醒应给出解法（先处理已有结果）')
  })
  await t.test('flat 模式成员派子代理：放行但提醒', async () => {
    const host = hostFor({ mode: 'flat' })
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
      host,
      execOf('subagent', memberSender(SPAWNED_NO_TASKS), { description: 'x', prompt: 'y' }),
    )
    assert.equal(threw, undefined, `flat 委派门禁不得抛异常：${threw instanceof Error ? threw.message : String(threw)}`)
    assert.equal(decisions.filter((decision) => decision?.kind === 'deny').length, 0, `flat 模式下 subagent 不得 deny，处理器返回：${stringify(decisions)}`)
    assert.equal(nextCalls, handlerCount, `flat 放行必须调用 next，实际 ${nextCalls} 次`)
    assert.equal(notices.length, 1, `必须恰好投递一条 flat 委派提醒，实际 ${notices.length} 条`)
    assert.match(notices[0]?.content?.[0]?.text ?? '', /flat 模式|派子代理/, 'flat 提醒应点名 flat 模式不派子代理')
  })
  await t.test('nested 模式白名单外：放行但提醒委派', async () => {
    const host = hostFor({ mode: 'nested' })
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
      host,
      execOf('bash', memberSender(SPAWNED_NO_TASKS), { command: 'ls' }),
    )
    assert.equal(threw, undefined, `nested 成员门禁不得抛异常：${threw instanceof Error ? threw.message : String(threw)}`)
    assert.equal(decisions.filter((decision) => decision?.kind === 'deny').length, 0, `nested 模式下成员跑 bash 不得 deny，处理器返回：${stringify(decisions)}`)
    assert.equal(nextCalls, handlerCount, `nested 放行必须调用 next，实际 ${nextCalls} 次`)
    assert.equal(notices.length, 1, `必须恰好投递一条成员门禁提醒，实际 ${notices.length} 条`)
    assert.match(notices[0]?.content?.[0]?.text ?? '', /(委派|subagent)/, 'nested 提醒应说明委派要求')
  })
})

test('用例 11：/using-agent-team off 时本门禁完全不干预（与其余三条门禁同一开关来源）', async (t) => {
  const offSession = (...events) => ({
    snapshotEvents: () => [{ type: 'command/run', data: { name: COMMAND_NAME, args: 'off' } }, ...events],
  })
  for (const mode of ['flat', 'nested']) {
    await t.test(`${mode} / off + 同一批已完成事件 → send_message 放行`, async () => {
      const host = hostFor({ mode })
      const agent = {
        id: LEAD_ID,
        session: { snapshotEvents: () => [] },
        membership: { role: 'lead', id: LEAD_ID, name: 'lead', root: { session: offSession(...FINISHED) } },
      }
      const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
        host,
        execOf('send_message', agent, { agent: 'worker-1', message: 'off 状态下的复用' }),
      )
      assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'send_message', label: 'off + 已完成成员' })
    })
  }
  await t.test('flat / off + 已完成成员自己 claim → 放行', async () => {
    const host = hostFor({ mode: 'flat' })
    const claimer = {
      id: 'm1',
      session: { snapshotEvents: () => [] },
      membership: { role: 'teammate', id: LEAD_ID, name: 'worker-1', root: { session: offSession(...FINISHED) } },
    }
    const { decisions, threw, nextCalls, handlerCount, notices } = await gateOutcome(
      host,
      execOf('team_task_update', claimer, { task_id: 't2', expected_revision: 1, action: 'claim' }),
    )
    assertAllowed({ threw, decisions, nextCalls, handlerCount, notices, tool: 'team_task_update', label: 'off 状态下的 claim' })
  })
})
