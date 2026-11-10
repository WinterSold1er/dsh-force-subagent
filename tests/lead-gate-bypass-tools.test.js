/**
 * task-5 取证旁路补齐：Lead 硬拦集合必须覆盖宿主真实存在的取证工具旁路。
 * 契约（权威）：
 *   EVIDENCE_TOOLS 除既有 bash / read / grep / glob / web_fetch / web_search 外，新增
 *     read_image —— 宿主真实注册名 packages/fs/tool-fs/src/read-image.ts:211；
 *     pwsh     —— 宿主真实注册名 packages/shell/tool-pwsh/src/index.ts:385；
 *   持久化 pwsh（packages/shell/tool-pwsh-persistent/src/index.ts:428）注册的模型可见工具名同样是 pwsh，
 *   所以一条 pwsh 同时封住前台与持久化两条路，不需要第二个名字。
 *   MCP 工具（模型可见名 mcp__<server>__<tool>）刻意不进硬拦集合（名字由服务器决定，逐名硬拦不可行），
 *   本文件用一条正向用例把这条已知缺口钉住：MCP 命名的工具不会被 Lead 门禁 deny。
 * 判据沿用既有 Lead 门禁：会话已 /using-agent-team 开启，且本轮既无委派类 tool/call、也无 running 成员 → deny；
 * 本轮已派发或有 running 成员 → 放行；header.delegationDepth>=1 的子代理不被自家门禁误伤。
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

/** 终端生命周期簿记工具：宿主存在（:365 / :396）但刻意不入集合，用 B12 把这条边界钉成可验证的契约。 */
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

/** 硬拦判据：不抛异常、恰好一条 deny、next 0 次、reason 点名被拒工具与出路、不投递提醒。 */
async function assertDenied(host, tool, agent, label) {
  const { nextCalls, decisions, threw } = await gateOutcome(host, execOf(tool, agent))
  assert.equal(threw, undefined, `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
  assert.equal(decisions.length, 1, `${label} / ${tool}：必须恰好一条门禁决策，实际 ${decisions.length} 条`)
  assert.equal(decisions[0]?.kind, 'deny', `${label} / ${tool}：必须 deny，实际：${JSON.stringify(decisions[0])}`)
  assert.equal(nextCalls, 0, `${label} / ${tool}：deny 时 next 必须 0 次，实际 ${nextCalls} 次`)
  const reason = String(decisions[0]?.reason ?? '')
  assert.match(reason, /^\[team-gate\] LEAD_EVIDENCE_DENIED:/, `${label} / ${tool}：deny 前缀必须是 [team-gate] LEAD_EVIDENCE_DENIED:，实际「${reason}」`)
  assert.ok(reason.includes(`「${tool}」`), `${label} / ${tool}：reason 必须点名被拒工具，实际「${reason}」`)
  assert.ok(reason.includes('team_task_create') && reason.includes('spawn_teammate'), `${label} / ${tool}：reason 必须给出唯一出路，实际「${reason}」`)
  assert.equal(agent?.notices?.length ?? 0, 0, `${label} / ${tool}：硬拦直接拒绝，不得投递提醒，实际 ${agent?.notices?.length ?? 0} 条`)
  return reason
}

async function assertAllowed(t, host, tool, agent, label) {
  const { nextCalls, decisions, threw } = await gateOutcome(host, execOf(tool, agent))
  assert.equal(threw, undefined, `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
  assert.equal(decisions.length, 1, `${label} / ${tool}：必须恰好一条决策，实际 ${decisions.length} 条`)
  assert.notEqual(decisions[0]?.kind, 'deny', `${label} / ${tool}：不得 deny，实际：${JSON.stringify(decisions[0])}`)
  assert.equal(nextCalls, 1, `${label} / ${tool}：放行必须 next 恰好 1 次，实际 ${nextCalls} 次`)
}

const LEAD_TURN = [runEvent('on'), turnStart(1)]

test(`契约：apply 注册 ${GATE_EVENT} 处理器（旁路断言的前提）`, (t) => {
  const host = leadHost()
  apply(host.ctx)
  const handlers = gateHandlers(host)
  assert.equal(handlers.length, 1, `必须恰好登记 1 个 ${GATE_EVENT} 处理器，实际 ${handlers.length} 个`)
  assert.equal(typeof handlers[0], 'function', '处理器必须是函数')
})

test(`B1 新增旁路工具逐个硬拦：Lead 本轮无派发无成员时 ${NEW_BYPASS_TOOLS.join(' / ')} 被 deny（next 0 次）`, async (t) => {
  for (const tool of NEW_BYPASS_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent(LEAD_TURN)
      const reason = await assertDenied(host, tool, agent, `B1 ${tool}`)
      assert.match(reason, /取证工具/, `B1 / ${tool}：旁路属于取证类，reason 必须点名「取证工具」，实际「${reason}」`)
      assert.deepEqual(host.warnings, [], `B1 / ${tool}：硬拦不得产生 fail-open warn，实际：${JSON.stringify(host.warnings)}`)
    })
  }
})

test('B2 同一轮连续两次旁路：两次都 deny（去重只作用于告警，不作用于拦截）', async () => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent(LEAD_TURN)
  for (const tool of ['pwsh', 'read_image', 'pwsh']) {
    const { nextCalls, decisions } = await gateOutcome(host, execOf(tool, agent))
    assert.equal(decisions[0]?.kind, 'deny', `B2 / ${tool}：必须仍然 deny，实际：${JSON.stringify(decisions[0])}`)
    assert.equal(nextCalls, 0, `B2 / ${tool}：next 必须 0 次`)
  }
})

test('B3 上一轮的 team_task_create 不算本轮证据：旁路工具仍被拒', async () => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('team_task_create'), turnStart(2)])
  await assertDenied(host, 'pwsh', agent, 'B3')
  await assertDenied(host, 'read_image', agent, 'B3')
})

test('B4 本轮已 spawn_teammate 且成员在跑：旁路工具放行（门禁判「本轮是否已派出活」）', async (t) => {
  for (const tool of NEW_BYPASS_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent([runEvent('on'), turnStart(1), toolCall('spawn_teammate'), memberEvent('child-1')])
      await assertAllowed(t, host, tool, agent, `B4 ${tool}`)
    })
  }
})

test('B5 Lead 派出的子代理（header.delegationDepth=1）用旁路工具不被自家门禁拦死', async (t) => {
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

test('B7 MCP 命名的工具不进硬拦集合（已知未覆盖，靠提示词承担告知）', async (t) => {
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

test('B9 实现类旁路没有被顺手放宽：write / edit 与新增取证工具在同一轮同样被拒', async () => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent(LEAD_TURN)
  const writeReason = await assertDenied(host, 'write', agent, 'B9')
  assert.match(writeReason, /实现工具/, 'B9 / write：实现类必须仍点名「实现工具」')
  const pwshReason = await assertDenied(host, 'pwsh', agent, 'B9')
  assert.match(pwshReason, /取证工具/, 'B9 / pwsh：取证旁路必须点名「取证工具」')
})

test(`B10 执行旁路逐个硬拦：Lead 本轮无派发无成员时 ${EXECUTION_TOOLS.join(' / ')} 被 deny（next 0 次，归类「执行工具」）`, async (t) => {
  for (const tool of EXECUTION_TOOLS) {
    await t.test(tool, async () => {
      const host = leadHost()
      apply(host.ctx)
      const agent = leadAgent(LEAD_TURN)
      const reason = await assertDenied(host, tool, agent, `B10 ${tool}`)
      assert.match(reason, new RegExp(`^\\[team-gate\\] LEAD_EVIDENCE_DENIED: 执行工具「${tool}」`), `B10 / ${tool}：执行类必须归类为「执行工具」并点名工具名，实际「${reason}」`)
      assert.match(reason, /执行工具本身就是取证与实现的等价通道/, `B10 / ${tool}：执行类必须说明它是取证与实现的等价通道，实际「${reason}」`)
      assert.deepEqual(host.warnings, [], `B10 / ${tool}：硬拦不得产生 fail-open warn，实际：${JSON.stringify(host.warnings)}`)
    })
  }
})

test('B11 执行旁路与实现类共用同一判据：同一轮内 run_code 被拒后转而 write 也照样被拒（不存在「换一个通道就能干活」）', async () => {
  const host = leadHost()
  apply(host.ctx)
  const agent = leadAgent(LEAD_TURN)
  const runReason = await assertDenied(host, 'run_code', agent, 'B11')
  assert.match(runReason, /执行工具「run_code」/, `B11 / run_code：必须归类为执行工具，实际「${runReason}」`)
  const writeReason = await assertDenied(host, 'write', agent, 'B11')
  assert.match(writeReason, /实现工具「write」/, `B11 / write：必须仍归类为实现工具，实际「${writeReason}」`)
  const bashReason = await assertDenied(host, 'bash', agent, 'B11')
  assert.match(bashReason, /取证工具「bash」/, `B11 / bash：取证类归类不得被新集合改写，实际「${bashReason}」`)
})

test('B12 本轮已 spawn_teammate 且成员在跑 / 子代理 delegationDepth=1：执行旁路放行', async (t) => {
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

test('B13 刻意的边界：terminal_close / terminal_list 不入集合（自身不执行任何东西，终端只能由已被拦的 terminal_open 建立），与 MCP 命名工具同为已知未覆盖', async (t) => {
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
