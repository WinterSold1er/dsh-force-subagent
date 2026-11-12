/**
 * task-5 取证旁路补齐 + task-11 执行旁路：Lead 软提醒集合必须覆盖宿主真实存在的取证 / 实现 / 执行工具旁路。
 * 契约（权威）：
 *   EVIDENCE_TOOLS 除既有 bash / read / grep / glob / web_fetch / web_search 外，新增
 *     read_image —— 宿主真实注册名 packages/fs/tool-fs/src/read-image.ts:211；
 *     pwsh     —— 宿主真实注册名 packages/shell/tool-pwsh/src/index.ts:385；
 *   持久化 pwsh（packages/shell/tool-pwsh-persistent/src/index.ts:428）注册的模型可见工具名同样是 pwsh，
 *   所以一条 pwsh 同时覆盖前台与持久化两条路，不需要第二个名字。
 *   MCP 工具（模型可见名 mcp__<server>__<tool>）刻意不进提醒集合（名字由服务器决定，逐名点名不可行），
 *   本文件用一条正向用例把这条已知缺口钉住：MCP 命名的工具不会被点名提醒。
 * 判据沿用既有 Lead 门禁（软口径，插件不拒绝任何工具调用）：会话已 /using-agent-team 开启，且本轮
 * （事件里最后一个 turn/start 之后）无委派类 tool/call → 工具照常放行（next 恰好一次）+ 一条 [team-gate] 提醒；
 * 本轮已派发 → 放行且不提醒；header.delegationDepth>=1 的子代理不被自家门禁提醒误伤。
 * 提醒按轮次去重：同一轮只提醒一次，新的 turn/start 到来后重新提醒一次；完整的按轮次证明见
 * tests/lead-gate-per-turn-reminder.test.js。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'

/** 新增的取证旁路：必须与宿主真实注册名逐字一致。 */
const NEW_BYPASS_TOOLS = ['read_image', 'pwsh']

/**
 * 新增的执行旁路（task-11）：同样逐个核对宿主 0.2.2-rc.1 真实注册名。
 *   run_code      —— packages/core/tool-executor-ptc/src/ptc.ts:298 `defineTool({ name: RUN_CODE_NAME })`，
 *                    常量值 'run_code' 见 packages/core/tools/src/contracts.ts:12；宿主只注册这一处。
 *   terminal_open / terminal_send / terminal_read / terminal_signal ——
 *                    packages/experimental/tool-terminal/src/index.ts:166 / :203 / :307 / :340；持久与非持久
 *                    后端同在这一个注册点、共用同一模型可见名，一条名字覆盖两条路。
 * 模型可见名全表见 packages/core/tools/tests/gen-tool-catalog.spec.ts:36（run_code）与 :41-42（terminal_*）。
 */
const EXECUTION_TOOLS = ['run_code', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal']

/** 终端生命周期簿记工具：宿主存在（:365 / :396）但刻意不入集合，用 B13 把这条边界钉成可验证的契约。 */
const TERMINAL_LIFECYCLE_TOOLS = ['terminal_close', 'terminal_list']

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const toolCall = (name) => ({ type: 'tool/call', data: { name } })
const memberEvent = (id, phase = 'active') => ({
  type: 'team/member',
  data: { version: 2, teamId: 'team-1', member: { id, name: `worker-${id}`, role: 'teammate', phase } },
})
const taskEvent = (id, status, ownerId) => ({
  type: 'team/task',
  data: { version: 2, teamId: 'team-1', task: { id, subject: `task ${id}`, status, revision: 1, blockedBy: [], ownerId } },
})

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

/** Lead 会话（真实形状暴露 snapshotEvents + Agent 的 inject notice 通道）。 */
const leadAgent = (events, header) => ({
  id: 'lead-1',
  session: { id: 'session-lead-1', snapshotEvents: () => events, ...(header ? { header } : {}) },
  notices: [],
  inject(message) {
    this.notices.push(message)
  },
})
const leadHost = () => createHost({ agentTeams: { tryMembership: () => undefined } })

/** 成员会话（真实 TeamMembership 形状：root.session 是 Lead 会话）。 */
const teammateAgent = (leadEvents, id = 'mate-1') => ({
  id,
  session: { id: `session-${id}`, snapshotEvents: () => [] },
  notices: [],
  inject(message) {
    this.notices.push(message)
  },
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

const gateHandlers = (host) => host.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)

async function gateOutcome(host, exec) {
  const handlers = gateHandlers(host)
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return Promise.resolve({ kind: 'allow', via: 'next' })
  }
  const decisions = []
  let threw
  try {
    for (const handler of handlers) decisions.push(await handler(exec, next))
  } catch (error) {
    threw = error
  }
  return { nextCalls, decisions, threw }
}

/** 软门禁判据（Lead 命中「本轮未派发」）：不抛异常、恰好一条决策、无 deny、next 恰好一次且返回值来自 next()，并恰好投递一条点名工具与出路的 [team-gate] 提醒；返回提醒正文供调用方核对归类。 */
async function assertReminded(host, tool, agent, label) {
  const { nextCalls, decisions, threw } = await gateOutcome(host, execOf(tool, agent))
  assert.equal(threw, undefined, `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
  assert.equal(decisions.length, 1, `${label} / ${tool}：必须恰好一条门禁决策，实际 ${decisions.length} 条`)
  assert.deepEqual(decisions[0], { kind: 'allow', via: 'next' }, `${label} / ${tool}：必须放行且返回值来自 next()，不得 deny，实际：${JSON.stringify(decisions[0])}`)
  assert.equal(nextCalls, 1, `${label} / ${tool}：放行必须 next 恰好 1 次，实际 ${nextCalls} 次`)
  const notices = agent?.notices ?? []
  assert.equal(notices.length, 1, `${label} / ${tool}：必须恰好投递一条 [team-gate] 提醒，实际 ${notices.length} 条`)
  const reminder = String(notices[0]?.content?.[0]?.text ?? '')
  assert.match(reminder, /^\[team-gate\] 提醒：/, `${label} / ${tool}：提醒前缀必须是「[team-gate] 提醒：」，实际「${reminder}」`)
  assert.ok(reminder.includes(`「${tool}」`), `${label} / ${tool}：提醒必须点名被放行的工具，实际「${reminder}」`)
  assert.ok(reminder.includes('team_task_create') && reminder.includes('subagent'), `${label} / ${tool}：提醒必须给出出路 team_task_create → subagent，实际「${reminder}」`)
  return reminder
}

/** 放行判据（门禁不命中：本轮已派发 / 子代理 / 开关 off / 不在集合内）：不抛异常、无 deny、next 恰好一次且返回值来自 next()，且不投递任何提醒。 */
async function assertAllowed(t, host, tool, agent, label) {
  const { nextCalls, decisions, threw } = await gateOutcome(host, execOf(tool, agent))
  assert.equal(threw, undefined, `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
  assert.equal(decisions.length, 1, `${label} / ${tool}：必须恰好一条决策，实际 ${decisions.length} 条`)
  assert.notEqual(decisions[0]?.kind, 'deny', `${label} / ${tool}：不得 deny，实际：${JSON.stringify(decisions[0])}`)
  assert.equal(nextCalls, 1, `${label} / ${tool}：放行必须 next 恰好 1 次，实际 ${nextCalls} 次`)
  assert.equal(agent?.notices?.length ?? 0, 0, `${label} / ${tool}：门禁不命中不得投递提醒，实际 ${agent?.notices?.length ?? 0} 条`)
}

const LEAD_TURN = [runEvent('on'), turnStart(1)]

test(`契约：apply 注册 ${GATE_EVENT} 处理器（旁路断言的前提）`, (t) => {
  const host = leadHost()
  apply(host.ctx)
  const handlers = gateHandlers(host)
  assert.equal(handlers.length, 1, `必须恰好登记 1 个 ${GATE_EVENT} 处理器，实际 ${handlers.length} 个`)
  assert.equal(typeof handlers[0], 'function', '处理器必须是函数')
})

test(`B1 新增旁路工具逐个放行 + 一次提醒：Lead 本轮未派发时 ${NEW_BYPASS_TOOLS.join(' / ')} 照常执行（next 1 次）并收到点名提醒`, async (t) => {
  for (const tool of NEW_BYPASS_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent(LEAD_TURN)
      const reminder = await assertReminded(host, tool, agent, `B1 ${tool}`)
      assert.match(reminder, /取证工具/, `B1 / ${tool}：旁路属于取证类，提醒必须点名「取证工具」，实际「${reminder}」`)
      assert.deepEqual(host.warnings, [], `B1 / ${tool}：判据成立是正常提醒，不得产生 fail-open warn，实际：${JSON.stringify(host.warnings)}`)
    })
  }
})

test('B2 同一轮连续三次旁路：三次全部放行，但只提醒一次（去重按轮次令牌，不作用于放行）', async () => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent(LEAD_TURN)
  for (const tool of ['pwsh', 'read_image', 'pwsh']) {
    const { nextCalls, decisions } = await gateOutcome(host, execOf(tool, agent))
    assert.deepEqual(decisions[0], { kind: 'allow', via: 'next' }, `B2 / ${tool}：必须放行且返回值来自 next()，不得 deny，实际：${JSON.stringify(decisions[0])}`)
    assert.equal(nextCalls, 1, `B2 / ${tool}：next 必须恰好 1 次，实际 ${nextCalls} 次`)
  }
  assert.equal(agent.notices.length, 1, `B2：同一轮只允许一条提醒，实际 ${agent.notices.length} 条`)
  assert.match(String(agent.notices[0]?.content?.[0]?.text ?? ''), /「pwsh」/, 'B2：提醒必须点名先命中的工具')
})

test('B3 上一轮的 team_task_create 不算本轮证据：本轮首次旁路仍然提醒，同轮第二次只放行', async () => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), turnStart(2)])
  await assertReminded(host, 'pwsh', agent, 'B3')
  const { nextCalls, decisions } = await gateOutcome(host, execOf('read_image', agent))
  assert.deepEqual(decisions[0], { kind: 'allow', via: 'next' }, `B3 第二次：必须放行，不得 deny，实际：${JSON.stringify(decisions[0])}`)
  assert.equal(nextCalls, 1, `B3 第二次：next 必须恰好 1 次，实际 ${nextCalls} 次`)
  assert.equal(agent.notices.length, 1, `B3：同一轮不得重复提醒，实际 ${agent.notices.length} 条`)
})

test('B4 本轮已 subagent：旁路工具放行且不提醒（门禁判「本轮是否已派出活」）', async (t) => {
  for (const tool of NEW_BYPASS_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('spawn_teammate'), memberEvent('child-1')])
      await assertAllowed(t, host, tool, agent, `B4 ${tool}`)
    })
  }
})

test('B5 Lead 派出的子代理（header.delegationDepth=1）用旁路工具不被自家门禁提醒误伤', async (t) => {
  for (const tool of NEW_BYPASS_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('spawn_teammate'), memberEvent('child-1')], { delegationDepth: 1 })
      await assertAllowed(t, host, tool, agent, `B5 ${tool}`)
    })
  }
})

test('B6 未开启 /using-agent-team 的会话：旁路工具放行（插件保持「off 即不干预」）', async (t) => {
  for (const tool of NEW_BYPASS_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([turnStart(1)])
      await assertAllowed(t, host, tool, agent, `B6 ${tool}`)
    })
  }
})

test('B7 MCP 命名的工具不进提醒集合（已知未覆盖，靠提示词承担告知）', async (t) => {
  const MCP_TOOLS = ['mcp__github__get_me', 'mcp__vectr__vectr_search']
  for (const tool of MCP_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent(LEAD_TURN)
      await assertAllowed(t, host, tool, agent, `B7 ${tool}`)
    })
  }
})

test('B8 成员会话（nested）的 pwsh / read_image 仍走既有成员门禁：放行 + 一次提醒，不被 Lead 集合卷入 deny', async (t) => {
  for (const tool of NEW_BYPASS_TOOLS) {
    await t.test(tool, async () => {
      const host = memberHost()
      apply(host.ctx)
      const agent = teammateAgent([runEvent('on')])
      const { nextCalls, decisions, threw } = await gateOutcome(host, execOf(tool, agent))
      assert.equal(threw, undefined, `B8 / ${tool}：不得抛异常`)
      assert.notEqual(decisions[0]?.kind, 'deny', `B8 / ${tool}：成员侧是软门禁，不得 deny，实际：${JSON.stringify(decisions[0])}`)
      assert.equal(nextCalls, 1, `B8 / ${tool}：成员侧必须放行（next 恰好 1 次），实际 ${nextCalls} 次`)
      assert.equal(agent.notices.length, 1, `B8 / ${tool}：必须投递一条成员软提醒，实际 ${agent.notices.length} 条`)
      assert.match(String(agent.notices[0]?.content?.[0]?.text ?? ''), /\[team-gate\] 提醒/, `B8 / ${tool}：提醒前缀必须是 [team-gate] 提醒`)
    })
  }
})

test('B9 实现类旁路没有被顺手放宽：write 与新增取证旁路 pwsh 同样命中一次点名提醒', async () => {
  const writeHost = leadHost()
  apply(writeHost.ctx)
  const writeReminder = await assertReminded(writeHost, 'write', leadAgent(LEAD_TURN), 'B9')
  assert.match(writeReminder, /实现工具/, 'B9 / write：实现类必须仍点名「实现工具」')
  const pwshHost = leadHost()
  apply(pwshHost.ctx)
  const pwshReminder = await assertReminded(pwshHost, 'pwsh', leadAgent(LEAD_TURN), 'B9')
  assert.match(pwshReminder, /取证工具/, 'B9 / pwsh：取证旁路必须点名「取证工具」')
})

test(`B10 执行旁路逐个放行 + 一次提醒：Lead 本轮未派发时 ${EXECUTION_TOOLS.join(' / ')} 照常执行（next 1 次，归类「执行工具」）`, async (t) => {
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent(LEAD_TURN)
      const reminder = await assertReminded(host, tool, agent, `B10 ${tool}`)
      assert.match(reminder, new RegExp(`^\\[team-gate\\] 提醒：.*执行工具「${tool}」`), `B10 / ${tool}：执行类必须归类为「执行工具」并点名工具名，实际「${reminder}」`)
      assert.match(reminder, /执行工具本身就是取证与实现的等价通道/, `B10 / ${tool}：执行类必须说明它是取证与实现的等价通道，实际「${reminder}」`)
      assert.deepEqual(host.warnings, [], `B10 / ${tool}：判据成立是正常提醒，不得产生 fail-open warn，实际：${JSON.stringify(host.warnings)}`)
    })
  }
})

test('B11 执行旁路与实现类共用同一判据：同一轮内先 run_code 后 write / bash 全部放行（不存在「换一个通道就能躲开判据」），且各类在新一轮各自点名归类', async (t) => {
  await t.test('同一轮内换通道：三次都放行，只提醒一次', async () => {
    const host = leadHost()
    apply(host.ctx)
    const agent = leadAgent(LEAD_TURN)
    for (const tool of ['run_code', 'write', 'bash']) {
      const { nextCalls, decisions } = await gateOutcome(host, execOf(tool, agent))
      assert.deepEqual(decisions[0], { kind: 'allow', via: 'next' }, `B11 同一轮 / ${tool}：必须放行，不得 deny，实际：${JSON.stringify(decisions[0])}`)
      assert.equal(nextCalls, 1, `B11 同一轮 / ${tool}：next 必须恰好 1 次，实际 ${nextCalls} 次`)
    }
    assert.equal(agent.notices.length, 1, `B11 同一轮：换通道不得带来第二条提醒，实际 ${agent.notices.length} 条`)
    assert.match(String(agent.notices[0]?.content?.[0]?.text ?? ''), /执行工具「run_code」/, `B11 同一轮：先命中的执行工具必须被点名，实际「${agent.notices[0]?.content?.[0]?.text ?? ''}」`)
  })
  for (const [tool, category] of [['run_code', '执行工具'], ['write', '实现工具'], ['bash', '取证工具']]) {
    await t.test(`${tool} 新一轮归类 ${category}`, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('spawn_teammate'), turnStart(2)])
      const reminder = await assertReminded(host, tool, agent, `B11 ${tool}`)
      assert.match(reminder, new RegExp(`${category}「${tool}」`), `B11 / ${tool}：必须归类为「${category}」并点名工具名，实际「${reminder}」`)
    })
  }
})

test('B12 本轮已 subagent / 子代理 delegationDepth=1：执行旁路放行且不提醒', async (t) => {
  for (const tool of EXECUTION_TOOLS) {
    await t.test(`${tool} 本轮已派发`, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('spawn_teammate'), memberEvent('m1')])
      await assertAllowed(t, host, tool, agent, `B12 ${tool} 本轮已派发`)
    })
    await t.test(`${tool} 子代理 delegationDepth=1`, async () => {
      const host = leadHost()
      apply(host.ctx)
      await assertAllowed(t, host, tool, leadAgent(LEAD_TURN, { delegationDepth: 1 }), `B12 ${tool} 子代理`)
    })
  }
})

test('B13 刻意的边界：terminal_close / terminal_list 不入集合（自身不执行任何东西，终端只能由已被点名的 terminal_open 建立），与 MCP 命名工具同为已知未覆盖', async (t) => {
  for (const tool of [...TERMINAL_LIFECYCLE_TOOLS, 'mcp__github__get_me']) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent(LEAD_TURN)
      await assertAllowed(t, host, tool, agent, `B13 ${tool}`)
    })
  }
})

test('B14 成员会话（nested）的执行旁路仍走既有成员门禁：放行 + 一次提醒，不被 Lead 集合卷入 deny', async (t) => {
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = memberHost()
      apply(host.ctx)
      const agent = teammateAgent([runEvent('on')])
      const { nextCalls, decisions, threw } = await gateOutcome(host, execOf(tool, agent))
      assert.equal(threw, undefined, `B14 / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
      assert.notEqual(decisions[0]?.kind, 'deny', `B14 / ${tool}：成员侧不得 deny，实际：${JSON.stringify(decisions[0])}`)
      assert.equal(nextCalls, 1, `B14 / ${tool}：成员侧必须 next 恰好 1 次，实际 ${nextCalls} 次`)
      assert.equal(agent.notices.length, 1, `B14 / ${tool}：成员侧必须投递一次提醒，实际 ${agent.notices.length} 条`)
      assert.match(String(agent.notices[0]?.content?.[0]?.text ?? agent.notices[0]), /^\[team-gate\]/, `B14 / ${tool}：提醒正文必须以 [team-gate] 前缀开头`)
    })
  }
})
