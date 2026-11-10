/**
 * task-22 软门禁（放行 + 提醒）与 flat 并行派发提示的专用测试。
 * 断言口径：
 *  - 软门禁（成员侧、wait_agent、已完成成员）：门禁命中后处理器不得返回 { kind:'deny' }，且必须调用 next 恰好一次（工具真的执行了）。
 *  - 硬门禁（Lead 取证工具 bash / pwsh / read / read_image / grep / glob / web_fetch / web_search
 *    + Lead 实现工具 write / edit / apply_patch / str_replace_editor
 *    + Lead 执行工具 run_code / terminal_open / terminal_read / terminal_send / terminal_signal，
 *    task-4 / task-8 / task-11）：
 *    判据命中必须返回 { kind:'deny', reason }（reason 点名被拒工具与唯一出路
 *    team_task_create / spawn_teammate），不得调用 next，也不得投递提醒；Lead 提示词必须预先告知该硬拒。
 *  - 提醒：调用方 Agent 的 inject 恰好收到 1 条 notice（source.form === 'notice'），正文以 [team-gate] 开头、
 *    点名被劝阻的工具，并给出正确做法（委派 / spawn 新成员 / 先登记任务 / 先处理已有结果）。
 *  - 去重：同一会话同一 key 反复命中只投递一次；不同已完成成员各投递一次。
 *  - 反例（证明断言不是恒真）：同一夹具把 Lead 开关换成 off → 0 条提醒；未命中判据的正常调用 → 0 条提醒。
 *  - fail-open：会话 Agent 没有 inject 方法、或 inject 抛错 → 工具仍放行（next 一次）且只 warn 一次。
 * 运行：node --test tests/gate-reminder.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'
const PREFIX = '[team-gate]'
const FINISHED_PREFIX = '[team-gate] TEAM_MEMBER_FINISHED:'

/** 真实 ctx 的最小形状（与 tests/mode-flat.test.js 同一套夹具）。 */
function createHost({ agentTeams } = {}) {
  const sections = []
  const registered = []
  const warnings = []
  const onCalls = []
  const ctx = {
    logger: { warn: (message) => { warnings.push(message) } },
    get: (service) => (
      service === 'systemPrompt' ? { section: (definition) => { sections.push(definition) } }
        : service === 'commands' ? { register: (definition) => { registered.push(definition) } }
          : service === 'agentTeams' ? agentTeams
            : undefined
    ),
    on: (...args) => { onCalls.push(args) },
    effect: (factory) => factory(),
    fiber: { uid: 'test-fiber' },
    settings: { configure: () => () => {} },
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: { uid: 'test-fiber' },
      settings: { configure: () => () => {} },
      logger: ctx.logger,
    }),
  }
  return { ctx, warnings, onCalls, sections, registered }
}

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const toolCall = (name, callId = `call-${name}`) => ({ type: 'tool/call', data: { name, callId } })
const memberEvent = (id, name) => ({
  type: 'team/member',
  data: { version: 2, teamId: 'team-1', member: { id, name, role: 'teammate', phase: 'active' } },
})
const taskEvent = (id, status, revision = 1, ownerId) => ({
  type: 'team/task',
  data: {
    version: 2,
    teamId: 'team-1',
    task: { id, subject: `task ${id}`, status, revision, blockedBy: [], ...(ownerId === undefined ? {} : { ownerId }) },
  },
})

/** 带 notice 投递通道的会话 Agent：复刻宿主 Agent 的 agent.inject，notices 供断言提醒条数。 */
function agentOf({ id = 'a1', events = [], membership, brokenInject } = {}) {
  const agent = {
    id,
    session: { events },
    notices: [],
    membership,
    inject(message) {
      if (brokenInject !== undefined) throw new Error(brokenInject)
      this.notices.push(message)
    },
  }
  if (brokenInject === 'no-method') delete agent.inject
  return agent
}

const membershipOf = ({ role = 'teammate', id = 'm1', name = 'worker-1', rootEvents = [runEvent('on')] } = {}) => ({
  role,
  id,
  name,
  root: { session: { events: rootEvents } },
})

const applyGate = (mode) => {
  const host = createHost({ agentTeams: { tryMembership: (agent) => agent?.membership ?? undefined } })
  apply(host.ctx, { mode })
  return host
}

/** 跑真实登记的门禁处理器；next 计数判定工具是否真的被放行。 */
async function runGate(host, tool, agent, args = {}, callId = `call-${tool}`) {
  const handlers = host.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)
  assert.equal(handlers.length, 1, `apply 必须恰好注册 1 个 ${GATE_EVENT} 处理器，实际 ${handlers.length} 个`)
  let nextCalls = 0
  const decisions = []
  let threw
  try {
    for (const handler of handlers) {
      decisions.push(await handler({ name: tool, arguments: args, callId, agent, signal: new AbortController().signal }, () => { nextCalls += 1 }))
    }
  } catch (error) {
    threw = error
  }
  return { decisions, threw, nextCalls, notices: agent.notices ?? [] }
}

const noticeText = (notice) => notice?.content?.[0]?.text ?? ''

/** 放行 + 恰好一条提醒。 */
async function assertRemindedOnce({ tool, host, agent, args, callId }, { label, hint }) {
  const { decisions, threw, nextCalls, notices } = await runGate(host, tool, agent, args, callId)
  assert.equal(threw, undefined, `${label}：门禁处理器不得抛异常，实际 ${threw instanceof Error ? threw.message : String(threw)}`)
  assert.equal(decisions.filter((d) => d?.kind === 'deny').length, 0, `${label}：软门禁不得 deny，实际 ${JSON.stringify(decisions)}`)
  assert.equal(nextCalls, 1, `${label}：工具必须被放行（next 恰好一次），实际 ${nextCalls} 次`)
  assert.equal(notices.length, 1, `${label}：必须恰好投递 1 条提醒，实际 ${notices.length} 条`)
  const text = noticeText(notices[0])
  assert.ok(text.startsWith(PREFIX), `${label}：提醒必须以 ${PREFIX} 开头，实际「${text}」`)
  assert.equal(notices[0]?.source?.form, 'notice', `${label}：提醒必须走 notice 通道，实际 ${JSON.stringify(notices[0]?.source)}`)
  assert.match(text, new RegExp(tool), `${label}：提醒必须点名工具「${tool}」，实际「${text}」`)
  assert.match(text, hint, `${label}：提醒必须给出正确做法（命中「${hint}」），实际「${text}」`)
  return { notices }
}

test('门禁 1 Lead 取证门禁：本轮无派发无成员就 read → 硬拒（deny，不投递提醒）；off 对照放行', async () => {
  const events = [runEvent('on'), turnStart(1)]
  const host = applyGate('flat')
  const agent = agentOf({ id: 'lead-1', events })
  const first = await runGate(host, 'read', agent)
  assert.equal(first.decisions.filter((d) => d?.kind === 'deny').length, 1, `Lead 无派发无成员取证必须返回一条 deny，实际 ${JSON.stringify(first.decisions)}`)
  assert.equal(first.nextCalls, 0, `被拒路径不得调用 next（工具不能执行），实际 ${first.nextCalls} 次`)
  const reason = first.decisions[0]?.reason
  assert.match(reason, /read/, `deny 理由必须点名被拒工具，实际「${reason}」`)
  assert.match(reason, /team_task_create/, `deny 理由必须点名唯一出路 team_task_create，实际「${reason}」`)
  assert.match(reason, /spawn_teammate/, `deny 理由必须点名唯一出路 spawn_teammate，实际「${reason}」`)
  assert.equal(agent.notices.length, 0, `硬门禁直接拒绝，不得投递提醒，实际 ${agent.notices.length} 条`)
  // 同一会话再取证一次：判据仍命中，仍然拒绝（去重只适用于软提醒）。
  const again = await runGate(host, 'read', agent)
  assert.equal(again.nextCalls, 0, '第二次取证同样必须被拒')
  assert.equal(agent.notices.length, 0, `被拒不得累积提醒，实际 ${agent.notices.length} 条`)
  // 反例：同一夹具把开关关掉，门禁完全不干预。
  const offHost = applyGate('flat')
  const offAgent = agentOf({ id: 'lead-off', events: [runEvent('on'), turnStart(1), runEvent('off'), turnStart(2)] })
  const off = await runGate(offHost, 'read', offAgent)
  assert.equal(off.nextCalls, 1, 'off 后必须放行')
  assert.equal(offAgent.notices.length, 0, `off 后不得投递提醒，实际 ${offAgent.notices.length} 条`)
})

test('门禁 1b Lead 本轮只有 team_task_create（没有派发、没有 running 成员）：bash 同样被拒', async () => {
  const host = applyGate('flat')
  const agent = agentOf({ id: 'lead-2', events: [runEvent('on'), turnStart(1), toolCall('team_task_create')] })
  const { decisions, nextCalls, notices } = await runGate(host, 'bash', agent)
  assert.equal(decisions.filter((d) => d?.kind === 'deny').length, 1, '只建看板不下场派活，取证必须 deny（否则 Lead 建完任务就能自己取证）')
  assert.equal(nextCalls, 0, `被拒路径不得调用 next，实际 ${nextCalls} 次`)
  assert.equal(notices.length, 0, `被拒不得投递提醒，实际 ${notices.length} 条`)
})

test('门禁 2 flat 成员派子代理：放行 + 只提醒一次（点名 flat 模式与自己执行）', async () => {
  const host = applyGate('flat')
  const agent = agentOf({ id: 'mate-flat', membership: membershipOf({ rootEvents: [runEvent('on')] }) })
  await assertRemindedOnce({ tool: 'subagent', host, agent }, { label: 'flat 成员派子代理', hint: /自己执行/ })
  const again = await runGate(host, 'workflow', agent)
  assert.equal(again.nextCalls, 1, 'flat 下 workflow 同样放行')
  assert.equal(agent.notices.length, 1, `同一成员会话只提醒一次委派，实际 ${agent.notices.length} 条`)
})

test('门禁 3 nested 成员白名单外：放行 + 只提醒一次（点名委派）', async () => {
  const host = applyGate('nested')
  const agent = agentOf({ id: 'mate-nested', membership: membershipOf({ rootEvents: [runEvent('on')] }) })
  await assertRemindedOnce({ tool: 'bash', host, agent }, { label: 'nested 成员执行类工具', hint: /(委派|subagent)/ })
  const allowed = await runGate(host, 'read', agent)
  assert.equal(allowed.nextCalls, 1, 'nested 白名单内 read 必须放行')
  assert.equal(agent.notices.length, 1, `白名单内工具不得追加提醒，实际 ${agent.notices.length} 条`)
})

test('门禁 4 wait_agent 连续空转：第二次等待放行 + 只提醒一次', async () => {
  const events = [runEvent('on'), turnStart(1), toolCall('wait_agent', 'call-prev'), toolCall('wait_agent', 'call-self')]
  const host = applyGate('nested')
  const agent = agentOf({ id: 'lead-wait', events })
  await assertRemindedOnce(
    { tool: 'wait_agent', host, agent, callId: 'call-self' },
    { label: '相邻两次 wait_agent', hint: /list_agents|team_task_list/ },
  )
  // 反例：两次等待之间夹了有效动作 → 判据不成立，放行且不提醒。
  const busyHost = applyGate('nested')
  const busyAgent = agentOf({ id: 'lead-busy', events: [runEvent('on'), turnStart(1), toolCall('wait_agent', 'call-prev'), toolCall('list_agents', 'call-list'), toolCall('wait_agent', 'call-self')] })
  const busy = await runGate(busyHost, 'wait_agent', busyAgent, {}, 'call-self')
  assert.equal(busy.nextCalls, 1, '中间有有效动作时必须放行')
  assert.equal(busyAgent.notices.length, 0, `中间有有效动作不得提醒，实际 ${busyAgent.notices.length} 条`)
})

test('门禁 5 已完成成员：放行 + 每个已完成成员只提醒一次', async () => {
  const leadEvents = [
    runEvent('on'),
    memberEvent('m1', 'worker-1'),
    taskEvent('t1', 'completed', 2, 'm1'),
    memberEvent('m2', 'worker-2'),
    taskEvent('t2', 'completed', 2, 'm2'),
  ]
  const host = applyGate('flat')
  const lead = agentOf({ id: 'lead-finished', events: leadEvents, membership: membershipOf({ role: 'lead', id: 'lead-1', name: 'lead', rootEvents: leadEvents }) })
  await assertRemindedOnce(
    { tool: 'send_message', host, agent: lead, args: { target: 'worker-1', message: '再改一轮' } },
    { label: 'Lead 发给已完成成员 worker-1', hint: /spawn_teammate/ },
  )
  assert.ok(lead.notices[0].content[0].text.startsWith(FINISHED_PREFIX), `提醒必须保留稳定前缀 ${FINISHED_PREFIX}`)
  const repeated = await runGate(host, 'send_message', lead, { target: 'worker-1', message: '再改一轮' })
  assert.equal(repeated.nextCalls, 1, '第二次同样放行')
  assert.equal(lead.notices.length, 1, `同一已完成成员只提醒一次，实际 ${lead.notices.length} 条`)
  const other = await runGate(host, 'send_message', lead, { target: 'worker-2', message: '换个活' })
  assert.equal(other.nextCalls, 1, '发给另一名已完成成员同样放行')
  assert.equal(lead.notices.length, 2, `不同已完成成员应各提醒一次，实际 ${lead.notices.length} 条`)
  // 反例：未完成成员（名下仍有 in_progress）不提醒。
  const busyHost = applyGate('flat')
  const busyEvents = [runEvent('on'), memberEvent('m3', 'worker-3'), taskEvent('t3', 'in_progress', 1, 'm3')]
  const busyLead = agentOf({ id: 'lead-busy-2', events: busyEvents, membership: membershipOf({ role: 'lead', id: 'lead-2', name: 'lead', rootEvents: busyEvents }) })
  const busy = await runGate(busyHost, 'send_message', busyLead, { target: 'worker-3', message: '继续' })
  assert.equal(busy.nextCalls, 1, '未完成成员必须放行')
  assert.equal(busyLead.notices.length, 0, `未完成成员不得触发提醒，实际 ${busyLead.notices.length} 条`)
})

test('提醒投递失败不改变工具结果：无 inject 方法 / inject 抛错 → 放行 + warn 一次', async () => {
  const cases = [
    { label: '无 inject 方法', brokenInject: 'no-method' },
    { label: 'inject 抛错', brokenInject: 'inject boom' },
  ]
  for (const { label, brokenInject } of cases) {
    // 软门禁侧（flat 成员派子代理）才会走提醒通道；Lead 取证门禁已改为直接拒绝，不走 inject。
    const host = applyGate('flat')
    const agent = agentOf({
      id: 'mate-broken',
      events: [],
      brokenInject,
      membership: membershipOf({ id: 'mate-broken', name: 'worker-broken', rootEvents: [runEvent('on')] }),
    })
    const { decisions, threw, nextCalls } = await runGate(host, 'subagent', agent)
    assert.equal(threw, undefined, `${label}：投递失败不得把异常抛给调用方`)
    assert.equal(decisions.filter((d) => d?.kind === 'deny').length, 0, `${label}：不得 deny`)
    assert.equal(nextCalls, 1, `${label}：工具必须照常放行`)
    const remindWarns = host.warnings.filter((message) => /提醒/.test(message))
    assert.equal(remindWarns.length, 1, `${label}：必须恰好 warn 一次，实际 ${remindWarns.length} 次：${host.warnings.join(' | ')}`)
    assert.match(remindWarns[0], /\[force-subagent\]/, `${label}：warn 必须点名插件，实际「${remindWarns[0]}」`)
    assert.match(remindWarns[0], /放行/, `${label}：warn 必须说明放行后果，实际「${remindWarns[0]}」`)
  }
})

const PARALLEL_RULES = ['拆成互不依赖的小任务', '单轮内并行 spawn', 'write_scopes 互斥', '不要串行建一个等一个']

const sectionText = (host, agent) => {
  assert.equal(host.sections.length, 1, '必须恰好注册一个 systemPrompt section')
  return host.sections[0].text({ agent })
}

test('flat 模式提示词：Lead 段与成员段都要求「拆小任务 + 单轮并行 spawn + write_scopes 互斥 + 不串行」', () => {
  const leadEvents = [runEvent('on')]
  const host = createHost({ agentTeams: { tryMembership: (agent) => agent?.membership ?? undefined } })
  apply(host.ctx, { mode: 'flat' })
  const leadText = sectionText(host, agentOf({ id: 'prompt-lead', events: leadEvents }))
  const memberText = sectionText(host, agentOf({ id: 'prompt-member', events: [], membership: membershipOf({ rootEvents: leadEvents }) }))
  for (const [name, text] of [['Lead 段', leadText], ['成员段', memberText]]) {
    for (const rule of PARALLEL_RULES) {
      assert.ok(text.includes(rule), `${name}必须包含「${rule}」，实际提示词为：${text}`)
    }
    assert.match(text, /flat 模式/, `${name}必须是 flat 模式提示词`)
  }
  // 反例：nested 成员段不得出现 flat 口径（断言不是恒真）。
  const nestedHost = createHost({ agentTeams: { tryMembership: (agent) => agent?.membership ?? undefined } })
  apply(nestedHost.ctx, { mode: 'nested' })
  const nestedText = sectionText(nestedHost, agentOf({ id: 'prompt-nested', events: [], membership: membershipOf({ rootEvents: leadEvents }) }))
  assert.doesNotMatch(nestedText, /flat 模式/, 'nested 成员段不得出现 flat 口径')
})

test('门禁口径：Lead 段必须预先告知「取证 + 实现 + 执行」会被硬拒，成员段仍是「放行 + 提醒」', () => {
  const host = createHost({ agentTeams: { tryMembership: (agent) => agent?.membership ?? undefined } })
  apply(host.ctx, { mode: 'flat' })
  const leadText = sectionText(host, agentOf({ id: 'wording-lead', events: [runEvent('on')] }))
  const memberText = sectionText(host, agentOf({ id: 'wording-member', events: [], membership: membershipOf({ rootEvents: [runEvent('on')] }) }))
  // Lead 段：硬拦工具与 deny 前缀必须写进提示词，不能只靠被拒后才知道。
  const LEAD_BLOCKED_TOOLS = ['bash', 'pwsh', 'read', 'read_image', 'grep', 'glob', 'web_fetch', 'web_search', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'run_code', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal']
  for (const tool of LEAD_BLOCKED_TOOLS) {
    assert.ok(leadText.includes(tool), `Lead 段必须点名会被硬拒的工具「${tool}」，实际提示词：${leadText}`)
  }
  assert.match(leadText, /\[team-gate\] LEAD_EVIDENCE_DENIED:/, `Lead 段必须给出 deny 前缀 [team-gate] LEAD_EVIDENCE_DENIED:，实际：${leadText}`)
  assert.match(leadText, /会被直接拒绝|会被硬拒/, `Lead 段必须说明这些工具会被硬拒（不是「放行 + 提醒」），实际：${leadText}`)
  assert.match(leadText, /team_task_create[\s\S]*spawn_teammate/, `Lead 段必须给出唯一出路 team_task_create → 单轮内并行 spawn_teammate，实际：${leadText}`)
  // 反例（断言不是恒真）：成员侧仍是软门禁，成员段不得宣称硬拒绝。
  assert.doesNotMatch(memberText, /已被门禁拒绝|会被拒绝|已被门禁拦/, `成员段不得宣称硬拒绝，实际：${memberText}`)
  for (const [name, text] of [['Lead 段', leadText], ['成员段', memberText]]) {
    assert.match(text, /放行但立即提醒|放行并投递|仍会成功/, `${name}必须说明「放行 + 提醒」的软门禁口径`)
  }
  // 硬拦不随模式变松：nested 的 Lead 段同样预先告知。
  const nestedLeadHost = createHost({ agentTeams: { tryMembership: (agent) => agent?.membership ?? undefined } })
  apply(nestedLeadHost.ctx, { mode: 'nested' })
  const nestedLeadText = sectionText(nestedLeadHost, agentOf({ id: 'wording-nested-lead', events: [runEvent('on')] }))
  assert.match(nestedLeadText, /\[team-gate\] LEAD_EVIDENCE_DENIED:/, `nested Lead 段必须同样预先告知硬拒，实际：${nestedLeadText}`)
  for (const tool of ['write', 'edit', 'apply_patch', 'str_replace_editor', 'run_code', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal']) {
    assert.ok(nestedLeadText.includes(tool), `nested Lead 段必须点名实现 / 执行工具「${tool}」，实际：${nestedLeadText}`)
  }
})

test('软门禁提醒正文（成员侧 flat，工具已执行）：不得沿用硬拒绝口径', () => {
  const gateHost = applyGate('flat')
  const agent = agentOf({ id: 'wording-gate', events: [], membership: membershipOf({ id: 'mate-wording', name: 'worker-wording', rootEvents: [runEvent('on')] }) })
  return runGate(gateHost, 'subagent', agent).then(({ notices }) => {
    const text = noticeText(notices[0])
    assert.doesNotMatch(text, /已被门禁拒绝|禁止直接执行/, '软门禁提醒正文不得沿用硬拒绝口径')
    assert.match(text, /本次已放行/, `软门禁必须说明本次已放行，实际「${text}」`)
  })
})
