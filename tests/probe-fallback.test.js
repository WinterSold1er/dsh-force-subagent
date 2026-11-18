/**
 * probe-fallback.test.js — 工具面探测「空结果」必须按探测失败处理（对抗审查 D-1 的回归守卫）。
 *
 * 事故根因（docs/review-rc2-fix.md D-1）：
 *   capabilitiesFromNames（index.js:493-504）没有 `names.size === 0` 判据，capabilitiesFor
 *   （index.js:1151-1163）在 definitions 返回空集合时直接产出「全 false」的能力快照 →
 *   delegationTier 落 none 档，把 Lead 劝成自己干活，而且不 warn。
 *   宿主侧这是真实状态：ResolvedToolSet.view(scope) 在 toolSet 已 dispose 或 scope 不匹配时
 *   返回空 Map（DSH 0.2.2-rc.2 packages/core/tools/src/index.ts:284-295），
 *   definitions(scope, toolSet) = [...toolSet.view(scope).values()] 于是返回空数组（同文件 :305）。
 *
 * 本文件断言的是「修复后应成立」的行为：空结果 == 探测失败 → warn 一次 + standard 档兜底，绝不落 none 档。
 *   P1 空数组 → standard 档（section 文案 + 门禁提醒），无 none 话术、无死工具名、不抛；
 *   P2 空 Map（宿主 view 的原始形状）→ 同上；
 *   P3 空结果必须恰好 warn 一次，且 warn 文案归因于「结果为空」（按语义关键词过滤，不是只数总数）；
 *   P4 definitions 抛错 → standard + warn 一次 + 不抛；
 *   P5 tools 服务缺失 → standard + warn 一次 + 不抛；
 *   P6 toolSet 为 undefined → standard + warn 一次 + 不抛；
 *   P7 scope 语义：exec.toolSet 存在但 scope 与解析者不一致 / exec 无 scope 字段而宿主返回空 → 仍走 fallback，不落 none 档；
 *   P8 反例守卫：探测成功且非空时不得误走 fallback（按能力差异证明用的是探测结果，不是安全默认）。
 *
 * 夹具沿用 tests/capability-tier.test.js / tests/lead-gate.test.js：真实 apply、真实 systemPrompt
 * section 与 tools/pre-execute 处理器，agent.inject 记录 notice；只替身宿主 services，绝不 mock 被测逻辑。
 * 运行：node --test tests/probe-fallback.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'

/** standard 档全量输出里一个都不许出现的死名字（rc.2 不存在 / 默认关闭 / 旧 spawn 面）。 */
const TIER2_FORBIDDEN = /spawn_teammate|team_task_|interrupt_agent|subagent_role|close_subagent/

/** standard 档的派发指令标志句：空结果兜底后必须出现，none 档不得出现。 */
const DISPATCH_INSTRUCTION = /再在单轮内并行 subagent 拉起|用 list_agents 记下成员名/

/** none 档话术：探测结果为空不等于「这个会话没有委派工具」，出现即等于把 Lead 劝成自己干活。 */
const NONE_TIER_WORDING = /没有探测到委派工具|没有委派能力|无法派发成员|由你直接执行/

/** 探测降级 warn 的语义族：既说明「工具面/探测/definitions」这一层，又说明「降级/兜底/回退」。 */
const isProbeFallbackWarning = (message) =>
  /(工具面|探测|definitions)/.test(message) && /(降级|兜底|回退|fallback|standard)/i.test(message)

/** 空结果这一条 warn 必须点明的原因（语义过滤，不接受「只 warn 了但原因含糊」）。 */
const EMPTY_RESULT_CAUSE = /空|empty|零|0 个|无任何|未取到|未解析|不可见|无可用|无工具/i

/** 不得把空结果谎报成别的降级原因（toolSet 缺失 / 探测抛错都对应另一条独立分支）。 */
const WRONG_PROBE_CAUSE = /toolSet 缺失|探测抛错|definitions 抛错|boom/

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const toolCall = (name) => ({ type: 'tool/call', data: { name } })

/** 宿主 view 返回空的替身：definitions 正常返回但清单为空（数组形状 / Map 形状）。 */
function makeEmptyTools(shape = 'array') {
  const calls = []
  return {
    calls,
    definitions(scope, toolSet) {
      calls.push({ scope, toolSet })
      return shape === 'map' ? new Map() : []
    },
  }
}

/** tools 服务替身：记录 definitions 实参；按 toolSet 上的字段决定返回真实清单还是模拟宿主 view 返回空。 */
function makeTools(resolveNames) {
  const calls = []
  return {
    calls,
    definitions(scope, toolSet) {
      calls.push({ scope, toolSet })
      const list = typeof resolveNames === 'function' ? resolveNames(toolSet, scope) : resolveNames
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

/** 一个夹具 = 一次 apply（独立 warn-once / 缓存 / 去重状态）+ 一个已开启 /using-agent-team 的 Lead 会话。 */
function fixture({ tools, omitTools = false, agentTeams, settings } = {}) {
  const toolService = omitTools ? undefined : tools
  // 身份来源必须可用，否则门禁按既有 fail-open 直接放行（看不到 caps 分支）。
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

/** 调真实注册的 tools/pre-execute 处理器：先按宿主顺序写入本次 tool/call 事件，再执行处理器。 */
async function gateCall(f, tool, toolSet) {
  const handlers = f.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)
  assert.equal(handlers.length, 1, `apply 必须恰好注册 1 个 ${GATE_EVENT} 处理器，实际 ${handlers.length} 个`)
  f.events.push(toolCall(tool))
  const decisions = []
  for (const handler of handlers) {
    decisions.push(await handler({
      callId: `call-${tool}-${f.events.length}`,
      name: tool,
      arguments: {},
      agent: f.agent,
      ...(toolSet === undefined ? {} : { toolSet }),
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'allow', via: 'next' })))
  }
  for (const decision of decisions) {
    assert.notEqual(decision?.kind, 'deny', `门禁不得返回 deny（实际 ${JSON.stringify(decision)}）`)
  }
  return decisions
}

/** standard 档兜底文案的硬判据：有派发指引、无 none 话术、无死工具名。 */
function assertStandardTierText(text, label) {
  assert.match(text, /subagent/, `${label}：兜底必须仍然给出 subagent 派发方式`)
  assert.match(text, DISPATCH_INSTRUCTION, `${label}：兜底必须落 standard 档（含「单轮内并行 subagent 拉起」派发指引）。实际：${text.slice(0, 300)}`)
  assert.doesNotMatch(text, NONE_TIER_WORDING, `${label}：探测结果为空不等于没有委派工具，不得出现 none 档话术。实际：${text.slice(0, 300)}`)
  assert.doesNotMatch(text, TIER2_FORBIDDEN, `${label}：兜底文案不得点名 rc.2 不存在/默认关闭的工具名`)
}

/** 取本次 apply 内的探测降级 warn（语义过滤，不是全部 warn）。 */
const probeWarnings = (f) => f.warnings.filter(isProbeFallbackWarning)

/** 恰好一条探测降级 warn，且原因写对了。 */
function assertProbeWarnOnce(f, causeRegex, label) {
  const found = probeWarnings(f)
  assert.equal(found.length, 1, `${label}：本次 apply 必须恰好 warn 一次（warn-once），实际 ${found.length} 条：${found.join(' | ')}`)
  assert.match(found[0], causeRegex, `${label}：warn 必须说明真实原因。实际：${found[0]}`)
  return found[0]
}

test('P1) definitions 返回空数组（宿主 view 空：toolSet 已释放 / scope 不匹配）→ 文案回落 standard 档，不落 none 档', async () => {
  const tools = makeEmptyTools('array')
  const f = fixture({ tools })
  const toolSet = { names: ['subagent', 'send_message', 'todo_write'], id: 'empty-array' }

  let section
  assert.doesNotThrow(() => { section = sectionText(f, toolSet, 'scope-empty-1') }, 'definitions 返回空数组时 section 不得抛异常')
  assertStandardTierText(section, 'P1 section 文案')

  await assert.doesNotReject(() => gateCall(f, 'bash', toolSet), '空结果时门禁不得抛异常')
  const gate = noticeTexts(f.agent).join('\n')
  assert.ok(gate.length > 0, 'Lead 亲自执行取证工具时必须投递门禁提醒')
  assertStandardTierText(gate, 'P1 门禁提醒')

  assert.equal(tools.calls.length, 1, '同一 toolSet 对象只应探测一次（按 toolSet 缓存）')
  assert.equal(tools.calls[0].toolSet, toolSet, '探测必须把本步 toolSet 原样传给 definitions')
})

test('P2) definitions 返回空 Map（宿主 ResolvedToolSet.view 的原始形状）→ 同样回落 standard 档 + 不抛 + 不落 none 档', async () => {
  const tools = makeEmptyTools('map')
  const f = fixture({ tools })
  const toolSet = { names: ['subagent', 'subagent_fork'], id: 'empty-map' }

  let section
  assert.doesNotThrow(() => { section = sectionText(f, toolSet, 'scope-empty-2') }, 'definitions 返回空 Map 时 section 不得抛异常')
  assertStandardTierText(section, 'P2 section 文案')

  let gateSection
  assert.doesNotThrow(() => { gateSection = sectionText(f, { names: ['subagent'], id: 'empty-map-2' }, 'scope-empty-2') }, '第二次探测同样不得抛')
  assertStandardTierText(gateSection, 'P2 第二次 section 文案')
})

test('P3) 空结果必须 warn 恰好一次，且 warn 文案归因于「结果为空」（不是含糊降级、也不是别的分支的原因）', async () => {
  const tools = makeEmptyTools('array')
  const f = fixture({ tools })

  sectionText(f, { id: 'empty-1' }, 'scope-a')
  sectionText(f, { id: 'empty-2' }, 'scope-b')
  await gateCall(f, 'bash', { id: 'empty-3' })

  assert.equal(tools.calls.length, 3, '三个独立 toolSet 必须各探测一次（不得因空结果跳过探测）')
  const message = assertProbeWarnOnce(f, EMPTY_RESULT_CAUSE, 'P3 空结果')
  assert.doesNotMatch(message, WRONG_PROBE_CAUSE, `P3 空结果不得被谎报成其它降级原因。实际：${message}`)
  assert.match(f.warnings.join('\n'), /\[force-subagent\]/, 'warn 必须走插件自己的前缀，便于宿主日志定位')
})

test('P4) definitions 抛错 → standard 档 + warn 一次 + 不抛异常', async () => {
  const f = fixture({ tools: { definitions() { throw new Error('boom') } } })

  let first
  assert.doesNotThrow(() => { first = sectionText(f, { id: 'throw-1' }, 'scope-throw') }, 'definitions 抛错时 section 不得抛异常')
  assertStandardTierText(first, 'P4 section 文案')
  assertProbeWarnOnce(f, /抛错|异常|boom|Error/i, 'P4 definitions 抛错')
  await assert.doesNotReject(() => gateCall(f, 'bash', { id: 'throw-2' }), 'definitions 抛错时门禁不得抛异常')
  assertStandardTierText(noticeTexts(f.agent).join('\n'), 'P4 门禁提醒')
  assert.equal(probeWarnings(f).length, 1, '抛错后的后续探测仍不得重复 warn（warn-once）')
})

test('P5) tools 服务缺失 → standard 档 + warn 一次 + 不抛异常', async () => {
  const f = fixture({ omitTools: true })

  let first
  assert.doesNotThrow(() => { first = sectionText(f, { id: 'no-tools' }, 'scope-no-tools') }, 'tools 服务缺失时 section 不得抛异常')
  assertStandardTierText(first, 'P5 section 文案')
  assertProbeWarnOnce(f, /tools 服务|服务不可用|无法读取/i, 'P5 tools 服务缺失')
  await assert.doesNotReject(() => gateCall(f, 'bash', { id: 'no-tools-gate' }), 'tools 服务缺失时门禁不得抛异常')
  assertStandardTierText(noticeTexts(f.agent).join('\n'), 'P5 门禁提醒')
})

test('P6) toolSet 为 undefined（省略 toolSet 会读到注册期可见集合）→ standard 档 + warn 一次 + 不抛异常', async () => {
  const f = fixture({ tools: makeTools(['bash']) })

  let first
  assert.doesNotThrow(() => { first = sectionText(f, undefined, 'scope-no-toolset') }, 'toolSet 缺失时 section 不得抛异常')
  assertStandardTierText(first, 'P6 section 文案')
  assertProbeWarnOnce(f, /toolSet/, 'P6 toolSet 缺失')
  await assert.doesNotReject(() => gateCall(f, 'bash', undefined), 'toolSet 缺失时门禁不得抛异常')
  assertStandardTierText(noticeTexts(f.agent).join('\n'), 'P6 门禁提醒')
})

test('P7) scope 语义：toolSet 存在但 scope 与解析者不一致 / exec 无 scope 字段而宿主返回空 → 走 fallback，不落 none 档', async () => {
  // 7a section 路径：宿主 view(scope) 因 scope 与 toolSet 归属不一致返回空 Map（packages/core/tools/src/index.ts:284-295）。
  {
    const owner = 'agent-owner'
    const tools = makeTools((toolSet, scope) => (scope === owner ? (toolSet.names ?? []) : []))
    const f = fixture({ tools })
    const toolSet = { names: ['subagent', 'subagent_fork', 'todo_write'], id: 'scope-mismatch' }

    let section
    assert.doesNotThrow(() => { section = sectionText(f, toolSet, 'scope-mismatch') }, 'scope 不一致导致返回空时 section 不得抛异常')
    assertStandardTierText(section, 'P7a section 文案')
    assert.equal(tools.calls.length, 1, 'P7a 必须真实探测一次，而不是因为 scope 可疑就跳过探测')
    assert.equal(tools.calls[0].scope, 'scope-mismatch', 'P7a 必须把本步 scope 原样交给宿主判定，不得自己改写')
    assert.equal(tools.calls[0].toolSet, toolSet, 'P7a 必须把本步 toolSet 原样交给宿主判定')
    assertProbeWarnOnce(f, EMPTY_RESULT_CAUSE, 'P7a scope 不一致导致空结果')
  }

  // 7b 门禁路径：exec 不带 scope 字段（宿主 ToolExecution 只有 toolSet），toolSet 已释放 → 宿主返回空。
  {
    const tools = makeTools((toolSet) => (toolSet.disposed === true ? [] : (toolSet.names ?? [])))
    const f = fixture({ tools })
    const toolSet = { names: ['subagent', 'send_message', 'todo_write'], id: 'disposed', disposed: true }

    await assert.doesNotReject(() => gateCall(f, 'bash', toolSet), 'toolSet 已释放时门禁不得抛异常')
    const reminder = noticeTexts(f.agent).join('\n')
    assert.ok(reminder.length > 0, 'Lead 亲自执行时必须投递门禁提醒')
    assertStandardTierText(reminder, 'P7b 门禁提醒')
    assert.equal(tools.calls.length, 1, 'P7b 必须真实探测一次')
    assert.equal(tools.calls[0].toolSet, toolSet, 'P7b 门禁探测必须用 exec.toolSet 本体')
    assert.equal(tools.calls[0].scope, f.agent, 'exec 无 scope 字段时探测 scope 必须回退到 exec.agent（否则宿主永远判成 scope 不匹配）')
    assertProbeWarnOnce(f, EMPTY_RESULT_CAUSE, 'P7b 已释放 toolSet 返回空')
  }
})

test('P8) 反例守卫：探测成功且非空时不得误走 fallback（用的是探测结果，不是安全默认）', async () => {
  const names = ['read', 'todo_write', 'subagent']
  const tools = makeTools((toolSet) => toolSet.names ?? [])
  const f = fixture({ tools })
  const toolSet = { names, id: 'probed-ok' }

  const section = sectionText(f, toolSet, 'scope-probed')
  assertStandardTierText(section, 'P8 section 文案')
  assert.match(section, /todo_write/, 'P8 探测到 todo_write，必须用 todo_write 任务板写法')
  // 探测结果里没有 subagent_fork：安全默认（STANDARD_CAPABILITIES）里有 fork:true 会多说「继承本会话上下文用 subagent_fork」。
  // 这条断言正是「误走 fallback」的判别位——出现即说明非空探测被误降级成安全默认。
  assert.doesNotMatch(section, /subagent_fork/, 'P8 探测到非空清单却缺 subagent_fork，文案不得声称 subagent_fork 可用（出现即误走安全默认）')

  assert.equal(tools.calls.length, 1, 'P8 必须真实探测一次')
  assert.equal(probeWarnings(f).length, 0, `非空探测不得产生降级 warn，实际：${probeWarnings(f).join(' | ')}`)
  assert.equal(f.warnings.length, 0, `P8 正常路径不得产生任何 warn，实际：${f.warnings.join(' | ')}`)

  await gateCall(f, 'bash', toolSet)
  assertStandardTierText(noticeTexts(f.agent).join('\n'), 'P8 门禁提醒')
  assert.equal(probeWarnings(f).length, 0, 'P8 门禁复用同一 toolSet 也不得产生降级 warn')
})
