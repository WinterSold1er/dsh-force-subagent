/**
 * task-14 收尾：Lead 门禁「按轮次刷新提醒」的专用测试。
 * 契约：提醒去重令牌 = 会话事件里最后一个 turn/start 的下标（index.js 的 `lead-evidence:${turnStart}`）。
 *   T1 同一轮连续两次命中只提醒一次；
 *   T2 新的 turn/start（新的用户消息开新一轮）之后重新提醒一次，累计 2 条 —— 本文件核心；
 *   T3 本轮已经 subagent 派发 → 命中工具放行且不提醒（同时充当 T1 / T2 的反例，证明断言不是恒真）；
 *   T4 源码断言：index.js 中 kind: 'deny' 出现 0 次，插件不返回任何拒绝结果；
 *   T5 17 个点名工具（取证 8 + 实现 4 + 执行 5）逐个：同轮内放行 + 恰好一次提醒。
 * 夹具与 tests/lead-gate-bypass-tools.test.js 同一口径：真实 Session 只暴露 snapshotEvents()，
 * Agent 的提醒通道是 agent.inject（notice 形态）。fail-open 场景见 tests/lead-gate.test.js（L8）。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'

/** 与 index.js 的三组点名集合逐字对齐；任一组被改写都会在这里转红，而不是静默失守。 */
const EVIDENCE_TOOLS = ['bash', 'read', 'grep', 'glob', 'web_fetch', 'web_search', 'read_image', 'pwsh']
const IMPLEMENTATION_TOOLS = ['write', 'edit', 'apply_patch', 'str_replace_editor']
const EXECUTION_TOOLS = ['run_code', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal']

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const toolCall = (name) => ({ type: 'tool/call', data: { name } })

function createHost() {
  const warnings = []
  const onCalls = []
  const services = {
    systemPrompt: { section: () => {} },
    commands: { register: () => {} },
    agentTeams: { tryMembership: () => undefined },
  }
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    effect: (factory) => factory(),
    fiber: { uid: 'test-fiber' },
    settings: { configure: () => () => {} },
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: ctx.fiber,
      settings: ctx.settings,
      logger: ctx.logger,
    }),
    get: (service) => services[service],
    on: (...args) => {
      onCalls.push(args)
    },
  }
  return { ctx, onCalls, warnings }
}

/** 一个夹具 = 一次 apply（独立的去重状态）+ 一个 Lead 会话。events 数组可变，用于追加新的 turn/start。 */
function leadFixture(events) {
  const host = createHost()
  apply(host.ctx)
  const agent = {
    id: 'lead-1',
    session: { id: 'session-lead-1', snapshotEvents: () => events },
    notices: [],
    inject(message) {
      this.notices.push(message)
    },
  }
  return { host, agent }
}

async function callGate(host, tool, agent) {
  const handlers = host.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)
  assert.equal(handlers.length, 1, `apply 必须恰好注册 1 个 ${GATE_EVENT} 处理器，实际 ${handlers.length} 个`)
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return Promise.resolve({ kind: 'allow', via: 'next' })
  }
  const decisions = []
  let threw
  try {
    for (const handler of handlers) {
      decisions.push(await handler({
        callId: `call-${tool}`,
        name: tool,
        arguments: {},
        agent,
        signal: new AbortController().signal,
      }, next))
    }
  } catch (error) {
    threw = error
  }
  return { nextCalls, decisions, threw }
}

/** 命中判据后的放行判据：不抛异常、恰好一条决策且来自 next()、无 deny、next 恰好一次。 */
async function assertAllowed(host, tool, agent, label) {
  const { nextCalls, decisions, threw } = await callGate(host, tool, agent)
  assert.equal(threw, undefined, `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
  assert.equal(decisions.length, 1, `${label} / ${tool}：必须恰好一条门禁决策，实际 ${decisions.length} 条`)
  assert.deepEqual(decisions[0], { kind: 'allow', via: 'next' }, `${label} / ${tool}：必须放行且返回值来自 next()，不得 deny，实际：${JSON.stringify(decisions[0])}`)
  assert.equal(nextCalls, 1, `${label} / ${tool}：next 必须恰好 1 次，实际 ${nextCalls} 次`)
}

const reminderText = (notice) => String(notice?.content?.[0]?.text ?? '')

test('T1 同一轮内连续两次 bash：两次都放行，只提醒一次', async () => {
  const { host, agent } = leadFixture([runEvent('on'), turnStart(1)])
  await assertAllowed(host, 'bash', agent, 'T1 第一次')
  await assertAllowed(host, 'bash', agent, 'T1 第二次')
  assert.equal(agent.notices.length, 1, `T1：同一轮只允许一条提醒，实际 ${agent.notices.length} 条`)
  assert.match(reminderText(agent.notices[0]), /^\[team-gate\] 提醒：/, `T1：提醒前缀必须是「[team-gate] 提醒：」，实际「${reminderText(agent.notices[0])}」`)
  assert.deepEqual(host.warnings, [], `T1：判据正常命中不得产生 fail-open warn，实际：${JSON.stringify(host.warnings)}`)
})

test('T2 新的 turn/start 之后再 bash：重新提醒一次（累计 2 条）——提醒按轮次刷新', async () => {
  const events = [runEvent('on'), turnStart(1)]
  const { host, agent } = leadFixture(events)
  await assertAllowed(host, 'bash', agent, 'T2 第一轮')
  assert.equal(agent.notices.length, 1, `T2：第一轮必须投递一条提醒，实际 ${agent.notices.length} 条`)
  // 本轮只建看板（team_task_create）不算派发：同轮再命中，仍然放行且不重复提醒。
  events.push(toolCall('team_task_create'))
  await assertAllowed(host, 'read', agent, 'T2 同轮第二次')
  assert.equal(agent.notices.length, 1, `T2：同一轮不得重复提醒，实际 ${agent.notices.length} 条`)
  // 新的 turn/start（新的用户消息开新一轮）到来 → 轮次令牌变化 → 再提醒一次。
  events.push(turnStart(2))
  await assertAllowed(host, 'bash', agent, 'T2 新一轮')
  assert.equal(agent.notices.length, 2, `T2：新的 turn/start 后必须再提醒一次，实际 ${agent.notices.length} 条`)
  assert.match(reminderText(agent.notices[1]), /^\[team-gate\] 提醒：/, `T2：第二条提醒同样必须是 [team-gate] 提醒，实际「${reminderText(agent.notices[1])}」`)
  // 反例（证明断言不是恒真）：同一轮内换工具再命中三次，条数仍然是 2，不会因换工具而刷新。
  for (const tool of ['grep', 'glob', 'write']) await assertAllowed(host, tool, agent, `T2 新一轮 / ${tool}`)
  assert.equal(agent.notices.length, 2, `T2：同一轮内换工具不得刷新提醒，实际 ${agent.notices.length} 条`)
})

test('T3 本轮已 subagent 派发：命中工具放行且不提醒', async () => {
  const { host, agent } = leadFixture([runEvent('on'), turnStart(1), toolCall('team_task_create'), toolCall('spawn_teammate')])
  for (const tool of ['bash', 'write', 'run_code']) await assertAllowed(host, tool, agent, `T3 ${tool}`)
  assert.equal(agent.notices.length, 0, `T3：本轮已派发不得投递提醒，实际 ${agent.notices.length} 条`)
  assert.deepEqual(host.warnings, [], `T3：不得产生 fail-open warn，实际：${JSON.stringify(host.warnings)}`)
})

test('T4 源码断言：index.js 中 kind: \'deny\' 出现 0 次（插件不返回任何拒绝结果）', () => {
  const source = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8')
  const denies = source.match(/kind:\s*'deny'/g) ?? []
  assert.equal(denies.length, 0, `index.js 不得出现 kind: 'deny'，实际 ${denies.length} 次`)
  const prefixes = source.match(/LEAD_EVIDENCE_DENIED/g) ?? []
  assert.equal(prefixes.length, 0, `index.js 不得残留 deny 文案前缀 LEAD_EVIDENCE_DENIED，实际 ${prefixes.length} 次`)
})

test('T5 17 个点名工具逐个（取证 8 + 实现 4 + 执行 5）：同轮内放行 + 恰好一次提醒', async (t) => {
  assert.equal(
    EVIDENCE_TOOLS.length + IMPLEMENTATION_TOOLS.length + EXECUTION_TOOLS.length,
    17,
    '点名工具必须是 17 个：取证 8 + 实现 4 + 执行 5',
  )
  for (const [category, tools] of [['取证', EVIDENCE_TOOLS], ['实现', IMPLEMENTATION_TOOLS], ['执行', EXECUTION_TOOLS]]) {
    assert.equal(
      tools.length,
      { 取证: 8, 实现: 4, 执行: 5 }[category],
      `T5：${category}类必须是 ${category === '取证' ? 8 : category === '实现' ? 4 : 5} 个，实际 ${tools.length} 个`,
    )
    for (const tool of tools) {
      await t.test(`${category} ${tool}`, async () => {
        const { host, agent } = leadFixture([runEvent('on'), turnStart(1)])
        await assertAllowed(host, tool, agent, `T5 ${tool} 第一次`)
        await assertAllowed(host, tool, agent, `T5 ${tool} 第二次`)
        assert.equal(agent.notices.length, 1, `T5 / ${tool}：同轮内必须恰好一次提醒，实际 ${agent.notices.length} 条`)
        const reminder = reminderText(agent.notices[0])
        assert.match(reminder, new RegExp(`「${tool}」`), `T5 / ${tool}：提醒必须点名该工具，实际「${reminder}」`)
        assert.match(reminder, /team_task_create[\s\S]*subagent/, `T5 / ${tool}：提醒必须给出 team_task_create → subagent 出路，实际「${reminder}」`)
        assert.deepEqual(host.warnings, [], `T5 / ${tool}：不得产生 fail-open warn，实际：${JSON.stringify(host.warnings)}`)
      })
    }
  }
})
