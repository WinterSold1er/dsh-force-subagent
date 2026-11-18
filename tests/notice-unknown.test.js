/**
 * notice-unknown.test.js — D-7（命令 notice 在能力未确认时必须中性）+ D-10（探测抛错支也要按 toolSet 缓存）。
 *
 * D-7 的契约：命令 handler 没有 step toolSet，notice 只能按「本会话最近一次能力快照」分文案。
 *   快照不存在（命令是本会话第一个动作：section 没装配过、门禁没跑过）或快照只来自降级默认
 *   （caps.probed !== true）时，notice 必须是中性句：既不承诺「实现与测试必须委派」，
 *   也不断言「本会话没有委派工具」——否则同轮里 notice 与随后装配的 section 可能互相打架。
 *   只有探测成功（probed === true）才按 none / 非 none 分档。
 * D-10 的契约：definitions 抛错那一支同样要按 toolSet 对象缓存降级结果（同一 toolSet 只探一次、
 *   只 warn 一次、文案稳定、绝不抛），换一个 toolSet 对象仍必须真实再探一次（不是全局粘住）。
 *
 * 夹具写法与 tests/probe-fallback.test.js、tests/capability-tier.test.js 一致：
 * 假 ctx.get('tools') / agent.inject / commands.register / systemPrompt.section，走真实 handler。
 * 所有正则锚点都取自实现文案，且每个「不得出现」的负向断言都在用例 2 里有对应的正向匹配作为对照，
 * 避免断言恒真。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'

// ── 文案锚点（语义关键词，不锁整句）────────────────────────────────────────────────────────────
/** 中性句锚点：只允许出现在「能力尚未确认」。 */
const NEUTRAL_CAPS = /真实工具面尚未确认/
const NEUTRAL_DEFER = /是否具备委派能力以本轮系统提示的 Agent-Team 段为准/
/** 正面档位命令句：只有探测成功且非空才允许出现。 */
const POSITIVE_COMMAND = /必须委派|派发成员承接|实现与测试/
/** 否定断言：只有确认「没有委派工具」（none 档）才允许出现。 */
const NEGATIVE_ASSERTION = /没有探测到委派工具|没有委派能力|未检测到委派工具|直接执行任务即可|无法派发成员|由你直接执行/
/** standard 档派发指令标志句（证明「降级兜底仍落 standard 档」）。 */
const DISPATCH_INSTRUCTION = /再在单轮内并行 subagent 拉起|用 list_agents 记下成员名/
/** 命令 notice 的固定前缀，用来证明 notice 真的投递了、不是空串。 */
const NOTICE_PREFIX = /^\[?【强制委派提醒】/

/** 探测降级 warn 的语义族（不是全部 warn）。 */
const isProbeFallbackWarning = (message) =>
  /(工具面|探测|definitions)/.test(message) && /(降级|兜底|回退|fallback|standard)/i.test(message)

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const toolCall = (name) => ({ type: 'tool/call', data: { name } })

// ── 三档真实工具面（rc.2 注册名，见 index.js TOOL_MARKERS）───────────────────────────────────────
const TEAM_NAMES = [
  'subagent', 'subagent_fork', 'send_message', 'list_agents', 'wait_agent',
  'interrupt_agent', 'todo_write', 'workflow', 'team_task_create', 'team_task_list', 'bash',
]
const STANDARD_NAMES = [
  'subagent', 'subagent_fork', 'send_message', 'list_agents', 'wait_agent',
  'todo_write', 'workflow', 'bash', 'read',
]
const NONE_NAMES = ['bash', 'read', 'write', 'edit', 'web_search']

/** tools 服务替身：记录 definitions 实参，按给定名字返回清单。 */
function makeTools(names) {
  const calls = []
  return {
    calls,
    definitions(scope, toolSet) {
      calls.push({ scope, toolSet })
      return names.map((name) => ({ name }))
    },
  }
}

/** definitions 恒抛错的 tools 服务替身（D-10 抛错支）。 */
function makeThrowingTools(error = new Error('boom-d10')) {
  const calls = []
  return {
    calls,
    definitions(scope, toolSet) {
      calls.push({ scope, toolSet })
      throw error
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

/** 一个夹具 = 一次 apply（独立 warn-once / toolSet 缓存 / 快照状态）+ 一个已开启 /using-agent-team 的 Lead 会话。 */
function fixture({ tools }) {
  // 身份来源必须可用，否则门禁按既有 fail-open 直接放行（看不到 caps 分支）。
  const host = createHost({ tools, agentTeams: { tryMembership: () => undefined } })
  apply(host.ctx)
  const events = [runEvent('on'), turnStart(1)]
  const agent = makeAgent(events)
  return { ...host, agent, events, tools }
}

/** 调真实注册的 systemPrompt section.text；React 式 context：{ agent, scope, toolSet }。 */
function sectionText(f, toolSet, scope = 'scope-notice-unknown') {
  assert.equal(f.systemPrompt.sections.length, 1, 'apply 必须恰好注册一个 systemPrompt section')
  return f.systemPrompt.sections[0].text({ agent: f.agent, scope, toolSet })
}

/** 调真实注册的 tools/pre-execute 处理器：先按宿主顺序写入本次 tool/call 事件，再执行处理器。 */
async function gateCall(f, tool, toolSet) {
  const handlers = f.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)
  assert.equal(handlers.length, 1, `apply 必须恰好注册 1 个 ${GATE_EVENT} 处理器，实际 ${handlers.length} 个`)
  f.events.push(toolCall(tool))
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
  return decisions
}

/** 执行真实注册的 /using-agent-team 命令 handler，单独记录 inject / steer 两路投递。 */
function runCommand(f, rawInput = 'on') {
  const command = f.commands.registered.find((definition) => definition.name === COMMAND_NAME)
  assert.ok(command, `apply 必须注册 /${COMMAND_NAME} 命令`)
  const injected = []
  const steered = []
  const agent = {
    id: 'command-agent',
    inject(message) { injected.push(message) },
    steer(message) { steered.push(message) },
  }
  const result = command.handler({ rawInput, agent })
  const texts = injected.map((message) => message?.content?.[0]?.text ?? '')
  return { result, injected, steered, text: texts.join('\n'), texts }
}

const probeWarnings = (f) => f.warnings.filter(isProbeFallbackWarning)

/** notice 必须是「一条、非空、带固定前缀」——先证明有东西可断言，后面的正则才有意义。 */
function assertSingleNotice(run, label) {
  assert.equal(run.result?.kind, 'success', `${label}：命令 handler 必须返回 success（实际 ${JSON.stringify(run.result)}）`)
  assert.equal(typeof run.result?.text, 'string', `${label}：命令必须返回会话页文本`)
  assert.ok(run.result.text.trim().length > 0, `${label}：会话页 text 不得为空`)
  assert.equal(run.injected.length, 1, `${label}：无 task 的 on 必须经 agent.inject 投递恰好一条 notice`)
  assert.equal(run.steered.length, 0, `${label}：无 task 的 on 不得走 steer`)
  assert.match(run.text, NOTICE_PREFIX, `${label}：notice 必须是带前缀的非空提醒文本，实际：${JSON.stringify(run.text)}`)
  return run.text
}

// ── 用例 1：命令先于任何探测 → 必须中性 ──────────────────────────────────────────────────────────
test('N1) 命令先于任何探测（section 未装配、无工具调用）→ notice 既许可以、也不否定，只给中性句', () => {
  const tools = makeTools(TEAM_NAMES)
  const f = fixture({ tools })

  // 前置条件成立性检查：命令 handler 之前，一次探测都没有发生。
  assert.equal(tools.calls.length, 0, '夹具在跑命令前不得装配 section、不得调门禁（否则快照已存在，测不到「未确认」）')
  assert.equal(f.warnings.length, 0, '没有探测就不该有任何 warn（不得凭空造一条降级 warn 再把 notice 写成中性句）')

  const run = runCommand(f, 'on')
  const text = assertSingleNotice(run, 'N1')

  assert.match(text, NEUTRAL_CAPS, `N1：未确认必须说「真实工具面尚未确认」。实际：${text}`)
  assert.match(text, NEUTRAL_DEFER, `N1：未确认必须把能力判断让给同轮 section。实际：${text}`)
  assert.doesNotMatch(text, POSITIVE_COMMAND, `N1：能力未确认时不得出现「必须委派」类正面命令。实际：${text}`)
  assert.doesNotMatch(text, NEGATIVE_ASSERTION, `N1：能力未确认时不得断言「没有委派工具 / 直接执行即可」。实际：${text}`)

  // 命令本身也不许顺手探测一次、或造一条 warn（快照只能来自真实探测）。
  assert.equal(tools.calls.length, 0, 'N1：命令 handler 不得为了写文案自己触发一次 definitions 探测')
  assert.equal(f.warnings.length, 0, 'N1：命令 handler 不得凭空产生 warn')
})

// ── 用例 2：反向守卫 —— 探测成功后三种档位各一条，中性句只在「未确认」出现 ────────────────────────
test('N2) 探测成功后按档分文案：team / standard 必须正面、none 必须否定，中性句一律不得出现', async () => {
  const cases = [
    { label: 'team 档', names: TEAM_NAMES, expect: 'positive' },
    { label: 'standard 档', names: STANDARD_NAMES, expect: 'positive' },
    { label: 'none 档', names: NONE_NAMES, expect: 'negative' },
  ]
  const notices = []

  for (const { label, names, expect } of cases) {
    const tools = makeTools(names)
    const f = fixture({ tools })
    const toolSet = { names, id: `ts-${label}` }

    // 先真实探测一次（section 装配），命令才有能力快照可用。
    const section = sectionText(f, toolSet)
    assert.equal(tools.calls.length, 1, `${label}：section 装配必须真实探测一次`)
    assert.equal(tools.calls[0].toolSet, toolSet, `${label}：探测必须把本步 toolSet 原样传给 definitions`)
    assert.equal(probeWarnings(f).length, 0, `${label}：探测成功不得产生降级 warn`)
    assert.doesNotMatch(section, NEUTRAL_CAPS, `${label}：探测成功后 section 也不得出现中性句`)

    const run = runCommand(f, 'on')
    const text = assertSingleNotice(run, label)
    notices.push({ label, text })

    assert.doesNotMatch(text, NEUTRAL_CAPS, `${label}：探测成功（probed === true）后 notice 不得再用中性句「尚未确认」`)
    assert.doesNotMatch(text, NEUTRAL_DEFER, `${label}：探测成功后不得把能力判断推给 section`)

    if (expect === 'positive') {
      assert.match(text, POSITIVE_COMMAND, `${label}：非 none 档必须给出正面委派命令（与 N1 的中性句互斥）。实际：${text}`)
      assert.doesNotMatch(text, NEGATIVE_ASSERTION, `${label}：探测到委派工具却断言「没有委派能力」= 自相矛盾。实际：${text}`)
      assert.match(section, DISPATCH_INSTRUCTION, `${label}：非 none 档 section 必须含派发指引。实际：${section.slice(0, 300)}`)
    } else {
      assert.match(text, NEGATIVE_ASSERTION, `${label}：none 档必须明确「未检测到委派工具 / 直接执行」。实际：${text}`)
      assert.doesNotMatch(text, POSITIVE_COMMAND, `${label}：none 档再命令「必须委派」就是同轮两条打架的指令。实际：${text}`)
    }
  }

  // notice 文案只按 none / 非 none 分档（档位内部的 team / standard 差异体现在 section 里），
  // 所以非 none 两档必须一致，none 档必须不同 —— 这才是分档契约。
  assert.equal(notices[1].text, notices[0].text, `${notices[1].label}与${notices[0].label}同为非 none 档，notice 必须同一份正面文案`)
  assert.notEqual(notices[2].text, notices[0].text, `none 档 notice 必须与非 none 档不同（不得对 none 档说「必须委派」）`)

  // 与「未确认」那一档对照：同一命令、同一个夹具，只是探测发生在前 / 在后 —— 中性句只属于后者。
  const unknownTools = makeTools(STANDARD_NAMES)
  const unknownFixture = fixture({ tools: unknownTools })
  assert.equal(unknownTools.calls.length, 0, '对照夹具必须没有任何探测（命令是本会话第一个动作）')
  const unknownNotice = assertSingleNotice(runCommand(unknownFixture, 'on'), 'N2 未确认对照')
  assert.match(unknownNotice, NEUTRAL_CAPS, 'N2 未确认对照：没有探测就必须走中性句')
  for (const { label, text } of notices) {
    assert.doesNotMatch(text, NEUTRAL_CAPS, `${label}：中性句只属于「未确认」这一档，探测成功后不得复用。实际：${text}`)
    assert.notEqual(text, unknownNotice, `${label}：探测成功后的 notice 必须与「未确认」中性句不同`)
  }
})

// ── 用例 3：definitions 抛错支也必须按 toolSet 缓存降级结果（D-10）────────────────────────────────
test('N3) definitions 抛错：同一 toolSet 连续 3 次 section + 1 次门禁 → 只探一次、只 warn 一次、文案稳定、不抛；换新 toolSet 仍真实再探', async () => {
  const tools = makeThrowingTools(new Error('boom-d10'))
  const f = fixture({ tools })
  const toolSet = { id: 'ts-throw-1' }

  const texts = []
  for (let index = 0; index < 3; index += 1) {
    assert.doesNotThrow(
      () => texts.push(sectionText(f, toolSet)),
      `definitions 抛错时 section 装配不得抛异常（第 ${index + 1} 次）`,
    )
    assert.equal(tools.calls.length, 1, `同一 toolSet 的第 ${index + 1} 次 section 装配不得重复调 definitions（抛错支也要缓存降级结果）`)
    assert.equal(probeWarnings(f).length, 1, `同一 toolSet 反复装配不得反复 warn（warn-once）`)
  }

  await assert.doesNotReject(() => gateCall(f, 'bash', toolSet), 'definitions 抛错时门禁不得抛异常')
  assert.equal(tools.calls.length, 1, '门禁复用同一 toolSet 对象必须命中缓存，definitions 仍只调 1 次')
  assert.equal(tools.calls[0].toolSet, toolSet, '唯一一次探测必须把本步 toolSet 原样传给 definitions')

  const found = probeWarnings(f)
  assert.equal(found.length, 1, `本次 apply 必须恰好 warn 一次（warn-once），实际 ${found.length} 条：${found.join(' | ')}`)
  assert.match(found[0], /抛错|异常|boom-d10|Error/i, `抛错这一条 warn 必须说明真实原因。实际：${found[0]}`)
  assert.match(f.warnings.join('\n'), /\[force-subagent\]/, 'warn 必须走插件自己的前缀，便于宿主日志定位')
  assert.equal(f.warnings.length, 1, `夹具里除这一条探测降级外不得出现第二条 warn：${f.warnings.join(' | ')}`)

  // 文案稳定：三次装配得到同一份降级文案（不是每轮重新拼一次、更不是忽而 standard 忽而 none）。
  assert.equal(texts.length, 3)
  assert.ok(texts[0].length > 0, '降级后的 section 文案不得为空')
  assert.equal(texts[1], texts[0], '同一 toolSet 的第二次 section 装配必须与第一次文案一致')
  assert.equal(texts[2], texts[0], '同一 toolSet 的第三次 section 装配必须与第一次文案一致')

  for (const [index, text] of texts.entries()) {
    assert.match(text, /subagent/, `第 ${index + 1} 次降级文案必须仍给出 subagent 派发方式`)
    assert.match(text, DISPATCH_INSTRUCTION, `第 ${index + 1} 次降级文案必须落 standard 档（含派发指引）。实际：${text.slice(0, 300)}`)
    assert.doesNotMatch(text, NEGATIVE_ASSERTION, `第 ${index + 1} 次：探测抛错不等于「本会话没有委派工具」，不得出现 none 档话术`)
    assert.doesNotMatch(text, /spawn_teammate|team_task_|interrupt_agent|subagent_role|close_subagent/, `第 ${index + 1} 次：降级文案不得点名 rc.2 不存在/默认关闭的工具名`)
  }

  const gateText = noticeTexts(f.agent).join('\n')
  assert.ok(gateText.length > 0, 'Lead 亲自执行取证工具时必须投递门禁提醒')
  assert.match(gateText, DISPATCH_INSTRUCTION, `门禁提醒同样必须落 standard 档。实际：${gateText.slice(0, 300)}`)
  assert.doesNotMatch(gateText, NEGATIVE_ASSERTION, '门禁提醒不得把抛错说成「没有委派能力」')

  // 换一个 toolSet 对象 → 判据可能已经变了，必须真实再探一次（不是全局粘住 / 不是永久降级）。
  const nextToolSet = { id: 'ts-throw-2' }
  assert.doesNotThrow(() => sectionText(f, nextToolSet), '新 toolSet 的 section 装配同样不得抛异常')
  assert.equal(tools.calls.length, 2, '换一个 toolSet 对象必须重新真实探测（缓存按 toolSet 对象，不是全局一次性降级）')
  assert.equal(tools.calls[1].toolSet, nextToolSet, '第二次探测必须用新的 toolSet 对象')
  assert.equal(probeWarnings(f).length, 1, '第二次探测仍受 warn-once 约束，不得重复 warn')
})
