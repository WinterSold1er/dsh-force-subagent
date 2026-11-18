/**
 * capability-tier.test.js — 注入文案 / 门禁提醒的「按本步真实工具面分档」契约测试。
 *
 * 覆盖（事故回归：旧文案静态写死 team_task_create 等 rc.2 不存在的工具，模型无路可走只能自己干）：
 *   C1 探测必须把本步 toolSet 原样传给 ctx.tools.definitions(scope, toolSet)（防读注册期可见集合的假阳性）；
 *   C2 三档矩阵：team（有 team_task_create）/ standard（只有 subagent 系列）/ none（无委派工具）；
 *   C3 Lead 门禁新规则：派发过 ≠ 整轮免检，read / grep / glob 已派发才豁免，未知工具命中；
 *   C4 降级链：tools 缺失 / definitions 抛错 / toolSet 缺失 → standard 档 + warn-once + 不抛；
 *   C5 模块 inject 契约包含 tools；
 *   C6 反例：toolSet 只有 bash 时不得声称有 subagent 可用。
 *
 * 夹具沿用 tests/lead-gate.test.js / tests/mode-flat.test.js：真实 apply、真实 tools/pre-execute
 * 处理器、agent.inject 记录 notice，绝不 mock 被测逻辑本身。
 * 运行：node --test tests/capability-tier.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'

/** standard 档全量输出里一个都不许出现的死名字（rc.2 不存在 / 默认关闭 / 旧 spawn 面）。 */
const TIER2_FORBIDDEN = /spawn_teammate|team_task_|interrupt_agent|subagent_role|close_subagent/

/** 派发指令的标志句：none 档不得出现，否则等于教模型调用不存在的工具。 */
const DISPATCH_INSTRUCTION = /再在单轮内并行 subagent 拉起|用 list_agents 记下成员名/

const TEAM_TOOLS = ['team_task_create', 'team_task_list', 'subagent', 'subagent_fork', 'send_message', 'list_agents', 'wait_agent', 'todo_write']
const STANDARD_TOOLS = ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'wait_agent']
const NONE_TOOLS = ['bash']
const GATE_TOOLS = ['bash', 'write', 'read', 'subagent', 'subagent_fork', 'send_message', 'list_agents', 'wait_agent', 'todo_write']

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const toolCall = (name) => ({ type: 'tool/call', data: { name } })

/** tools 服务替身：记录每次 definitions 的实参，并按收到的 toolSet.names 返回工具清单。 */
function makeTools(names) {
  const calls = []
  return {
    calls,
    definitions(scope, toolSet) {
      calls.push({ scope, toolSet })
      const list = typeof names === 'function' ? names(toolSet) : names
      return list.map((name) => ({ name }))
    },
  }
}

function makeAgent(events) {
  return {
    id: 'lead-1',
    session: { id: 'session-lead-1', events, snapshotEvents: () => events },
    notices: [],
    inject(message) { this.notices.push(message) },
  }
}

/** notice 通道的记录形态是 UserMessage；取正文文本用于断言。 */
const noticeTexts = (agent) => agent.notices.map((message) => message?.content?.[0]?.text ?? '')

function createHost({ tools, agentTeams, settings } = {}) {
  const systemPrompt = {
    sections: [],
    section(definition) { this.sections.push(definition) },
  }
  const commands = {
    registered: [],
    register(definition) { this.registered.push(definition) },
  }
  const warnings = []
  const onCalls = []
  const services = {
    systemPrompt,
    commands,
    settings: settings ?? { configure: () => () => {} },
    agentTeams,
    tools,
  }
  const ctx = {
    logger: { warn: (message) => { warnings.push(String(message)) } },
    effect: (factory) => factory(),
    fiber: { uid: 'test-fiber' },
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: { uid: 'test-fiber' },
      settings: { configure: () => () => {} },
      logger: { warn: (message) => { warnings.push(String(message)) } },
    }),
    get: (service) => services[service],
    on: (...args) => { onCalls.push(args) },
  }
  return { ctx, warnings, onCalls, systemPrompt, commands }
}

/** 一个夹具 = 一次 apply（独立 warn-once / 去重状态）+ 一个已开启 /using-agent-team 的 Lead 会话。 */
function fixture({ names, tools, omitTools = false, agentTeams, settings } = {}) {
  const toolService = omitTools ? undefined : (tools ?? makeTools(names ?? []))
  // 身份来源必须可用，否则门禁按既有 fail-open 直接放行（看不到 caps 分支）；tryMembership 返回
  // undefined = 该会话不是 rc.1 团队成员，随后走 rc.2 rootOf 判定，这里同样没有 → 普通 Lead 会话。
  const host = createHost({ tools: toolService, agentTeams: agentTeams ?? { tryMembership: () => undefined }, settings })
  apply(host.ctx)
  const events = [runEvent('on'), turnStart(1)]
  const agent = makeAgent(events)
  return { ...host, agent, events, tools: toolService }
}

/** 调真实注册的 systemPrompt section.text；React 式 context：{ agent, scope, toolSet }。 */
function sectionText(f, toolSet, scope = 'scope-test') {
  assert.equal(f.systemPrompt.sections.length, 1, 'apply 必须恰好注册一个 systemPrompt section')
  return f.systemPrompt.sections[0].text({ agent: f.agent, scope, toolSet })
}

/** 调真实注册的 tools/pre-execute 处理器：按宿主顺序先把本次 tool/call 写入会话事件，再执行。 */
async function gateCall(f, tool, toolSet, { appendCurrentCall = true } = {}) {
  const handlers = f.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)
  assert.equal(handlers.length, 1, `apply 必须恰好注册 1 个 ${GATE_EVENT} 处理器，实际 ${handlers.length} 个`)
  if (appendCurrentCall) f.events.push(toolCall(tool))
  let nextCalls = 0
  const decisions = []
  for (const handler of handlers) {
    decisions.push(await handler({
      callId: `call-${tool}-${f.events.length}`,
      name: tool,
      arguments: {},
      agent: f.agent,
      ...(toolSet === undefined ? {} : { toolSet }),
      signal: new AbortController().signal,
    }, () => {
      nextCalls += 1
      return Promise.resolve({ kind: 'allow', via: 'next' })
    }))
  }
  assert.equal(nextCalls, 1, '门禁必须恰好放行一次（next 恰好调用一次）')
  for (const decision of decisions) {
    assert.notEqual(decision?.kind, 'deny', `门禁不得返回 deny（实际 ${JSON.stringify(decision)}）`)
  }
  return { decisions, nextCalls }
}

/** 命令 notice 文本（与门禁提醒同属模型可见文案，一起纳入零匹配断言）。 */
function commandNotice(f) {
  const command = f.commands.registered.find((definition) => definition.name === COMMAND_NAME)
  assert.ok(command, `apply 必须注册 /${COMMAND_NAME} 命令`)
  const noticeAgent = { id: 'notice-agent', notices: [], inject(message) { this.notices.push(message) } }
  const result = command.handler({ rawInput: '', agent: noticeAgent })
  assert.equal(result?.kind, 'success', '命令 handler 必须返回 success')
  assert.equal(noticeAgent.notices.length, 1, '命令必须投递恰好一条 notice')
  return noticeAgent.notices[0]?.content?.[0]?.text ?? ''
}

/** 一次 apply 内收集 Lead 文案三件套：section 正文 + 命令 notice + 真实门禁提醒。 */
async function collectTierTexts(names) {
  const f = fixture({ names })
  const section = sectionText(f, { names: [...names], id: 'section' })
  const notice = commandNotice(f)
  await gateCall(f, 'bash', { names: [...names], id: 'gate' })
  const gate = noticeTexts(f.agent).join('\n')
  return { f, section, notice, gate, combined: [section, notice, gate].join('\n') }
}

const probeWarnings = (f) => f.warnings.filter((message) => /降级为标准委派文案/.test(message))

test('C1) 探测必须把本步 toolSet 原样传给 definitions（防注册期集合假阳性）', async () => {
  const tools = makeTools((toolSet) => toolSet.names ?? [])
  const f = fixture({ tools })

  const ts = { names: ['bash'], id: 'x' }
  const text = sectionText(f, ts, 'scope-1')
  assert.equal(tools.calls.length, 1, 'section 装配必须恰好探测一次')
  assert.equal(tools.calls[0].scope, 'scope-1', 'definitions 第一个参数应为本步 scope')
  assert.equal(tools.calls[0].toolSet, ts, 'definitions 第二个参数必须就是本步 toolSet 对象本身')
  assert.match(text, /没有探测到委派工具/, 'toolSet 只有 bash 时不得被判成有委派能力（读注册期集合就会假阳性）')

  const gateTs = { names: ['subagent', 'send_message'], id: 'gate' }
  await gateCall(f, 'bash', gateTs)
  const gateProbe = tools.calls.at(-1)
  assert.equal(gateProbe.toolSet, gateTs, 'tools/pre-execute 探测必须传 exec.toolSet')
  assert.equal(gateProbe.scope, f.agent, '未提供 scope 时探测 scope 回退到 exec.agent')
})

test('C2a) team 档（有 team_task_create）→ 出现看板句', async () => {
  const { combined } = await collectTierTexts(TEAM_TOOLS)
  assert.match(combined, /team_task_create/, 'team 档必须名称真实存在的看板工具')
  assert.match(combined, /看板/, 'team 档必须保留看板式流程')
})

test('C2b) standard 档（只有 subagent 系列）→ 对死工具名零匹配', async () => {
  const { section, combined } = await collectTierTexts(STANDARD_TOOLS)
  assert.match(section, /subagent/, 'standard 档必须仍然说明派发方式')
  assert.doesNotMatch(combined, TIER2_FORBIDDEN,
    `standard 档全量文案不得出现 rc.2 不存在/默认关闭的工具名：${TIER2_FORBIDDEN}`)
})

test('C2c) none 档（没有委派工具）→ 说明没有委派能力、直接执行，且不派发指令', async () => {
  const { combined } = await collectTierTexts(NONE_TOOLS)
  assert.match(combined, /没有探测到委派工具/, 'none 档必须明确说没有委派能力')
  assert.match(combined, /直接执行/, 'none 档必须给出「直接执行」的出路')
  assert.doesNotMatch(combined, DISPATCH_INSTRUCTION, 'none 档不得出现 subagent 派发指令')
  assert.doesNotMatch(combined, TIER2_FORBIDDEN, 'none 档不得点名死工具')
})

test('C3) Lead 门禁新规则：派发过 ≠ 整轮免检，read 已派发才豁免，未知工具命中', async () => {
  // 3a 同 turn 先 subagent 再 write → 恰好 1 条提醒
  {
    const f = fixture({ names: GATE_TOOLS })
    const ts = { names: GATE_TOOLS }
    await gateCall(f, 'subagent', ts)
    assert.equal(f.agent.notices.length, 0, 'subagent 是编排动作，不得提醒')
    await gateCall(f, 'write', ts)
    assert.equal(f.agent.notices.length, 1, '派发过之后 Lead 亲自 write 仍必须提醒一次')
    assert.match(noticeTexts(f.agent)[0], /^\[team-gate\]/)
  }

  // 3b 同 turn 先 subagent 再 read → 0 条（已派发后的校验豁免）
  {
    const f = fixture({ names: GATE_TOOLS })
    const ts = { names: GATE_TOOLS }
    await gateCall(f, 'subagent', ts)
    await gateCall(f, 'read', ts)
    assert.equal(f.agent.notices.length, 0, '本轮已派发后 read 属于校验，不得提醒')
  }

  // 3c 未知工具（mcp__* / office_*）→ 命中提醒
  for (const tool of ['mcp__github__search_code', 'office_render']) {
    const f = fixture({ names: GATE_TOOLS })
    await gateCall(f, tool, { names: GATE_TOOLS })
    assert.equal(f.agent.notices.length, 1, `未知工具 ${tool} 必须命中 Lead 门禁提醒`)
    assert.match(noticeTexts(f.agent)[0], /team-gate/, `${tool} 的提醒必须带 [team-gate] 前缀`)
  }

  // 3d 跨 turn：新 turn/start 后重新提醒一条
  {
    const f = fixture({ names: GATE_TOOLS })
    const ts = { names: GATE_TOOLS }
    await gateCall(f, 'bash', ts)
    assert.equal(f.agent.notices.length, 1, '本轮第一次命中提醒一次')
    await gateCall(f, 'bash', ts)
    assert.equal(f.agent.notices.length, 1, '同一 turn 内不得重复提醒')
    f.events.push(turnStart(2))
    await gateCall(f, 'bash', ts)
    assert.equal(f.agent.notices.length, 2, '新 turn 必须重新提醒一次')
  }
})

test('C4) 降级链：tools 缺失 / definitions 抛错 / toolSet 缺失 → standard 档 + warn 一次 + 不抛', async () => {
  // 4a tools 服务缺失
  {
    const f = fixture({ omitTools: true })
    const ts = { id: 'missing-tools' }
    let first
    assert.doesNotThrow(() => { first = sectionText(f, ts, 'scope-a') }, 'tools 缺失时 section 不得抛异常')
    assert.doesNotThrow(() => { sectionText(f, ts, 'scope-a') })
    assert.match(first, /todo_write/, '降级必须落到 standard 档文案')
    assert.doesNotMatch(first, /team_task_|interrupt_agent/, '降级文案仍不得点名死工具')
    assert.equal(probeWarnings(f).length, 1, `本次 apply 探测降级必须只 warn 一次，实际：${probeWarnings(f).join(' | ')}`)
    await assert.doesNotReject(() => gateCall(f, 'bash', { id: 'missing-gate' }), 'tools 缺失时门禁不得抛异常')
  }

  // 4b definitions 抛错
  {
    const f = fixture({ tools: { definitions() { throw new Error('boom') } } })
    let first
    assert.doesNotThrow(() => { first = sectionText(f, { id: 'throw-1' }, 'scope-b') }, 'definitions 抛错时 section 不得抛异常')
    assert.doesNotThrow(() => { sectionText(f, { id: 'throw-2' }, 'scope-b') })
    assert.match(first, /todo_write/, 'definitions 抛错必须降级 standard 档文案')
    assert.doesNotMatch(first, /team_task_|interrupt_agent/, '降级文案仍不得点名死工具')
    assert.equal(probeWarnings(f).length, 1, `definitions 抛错必须只 warn 一次，实际：${probeWarnings(f).join(' | ')}`)
  }

  // 4c toolSet 缺失（省略会读到注册期可见集合）
  {
    const f = fixture({ names: ['bash'] })
    let first
    assert.doesNotThrow(() => { first = sectionText(f, undefined, 'scope-c') }, 'toolSet 缺失时 section 不得抛异常')
    assert.doesNotThrow(() => { sectionText(f, undefined, 'scope-c') })
    assert.match(first, /todo_write/, 'toolSet 缺失必须降级 standard 档文案')
    assert.doesNotMatch(first, /team_task_|interrupt_agent/, '降级文案仍不得点名死工具')
    assert.equal(probeWarnings(f).length, 1, `toolSet 缺失必须只 warn 一次，实际：${probeWarnings(f).join(' | ')}`)
  }
})

test('C5) 模块 inject 契约包含 tools', () => {
  assert.ok(Array.isArray(plugin.inject), 'inject 必须是数组')
  assert.ok(plugin.inject.includes('tools'), `inject 必须包含 'tools'，实际：${JSON.stringify(plugin.inject)}`)
})

test('C6) 反例：toolSet 只有 bash 时文案不得声称有 subagent 可用', async () => {
  const f = fixture({ names: NONE_TOOLS })
  const ts = { names: ['bash'], id: 'bash-only' }
  const section = sectionText(f, ts)
  assert.match(section, /没有探测到委派工具/, '必须承认没有探测到委派工具')
  assert.doesNotMatch(section, DISPATCH_INSTRUCTION, '只有 bash 时不得出现 subagent 派发指令')
  assert.doesNotMatch(section, /正确做法：/, '只有 bash 时不得给出「正确做法」式派发指引')

  await gateCall(f, 'bash', { names: ['bash'], id: 'bash-only-gate' })
  const reminder = noticeTexts(f.agent).join('\n')
  assert.match(reminder, /由你直接执行|直接执行/, 'none 档门禁提醒必须说直接执行')
  assert.doesNotMatch(reminder, DISPATCH_INSTRUCTION, 'none 档门禁提醒不得出现派发指令')
})
