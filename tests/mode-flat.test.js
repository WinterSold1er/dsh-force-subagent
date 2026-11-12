/**
 * dsh-force-subagent 双模式测试（Config.mode: 'nested' | 'flat'）。
 * 契约口径：
 * - 缺省 / 空串 / null → 'nested'；只有字符串 'flat' 算 flat；其它非法取值 warn 一次后按 'nested'。
 * - flat 成员提示词整段替换：含 flat 关键词与五个被禁委派工具名，不含 nested 关键句、不含字面量 team_task_create。
 * - flat Lead 提示词追加软踢出段：逐条成员消息先判定完成，完成即 interrupt_agent + team_task_update，之后不再 send_message / 不复用；并写明宿主没有删除成员的 API。
 * - flat 门禁（task-22 软门禁口径）：成员调 subagent / subagent_fork / subagent_role / close_subagent / workflow 放行 + 提醒一次（next 恰好一次）；成员调 write / edit / bash 放行且不提醒。
 * - nested 门禁口径不回归：成员调 subagent 放行不提醒、调 bash 放行但提醒一次。
 * 脚手架沿用 tests/member-gate-deny.test.js（真实监听器 + next 计数）与 tests/force-subagent.test.js（section 捕获）。
 * 运行：node --test tests/mode-flat.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply, resolveConfig, DEFAULT_CONFIG } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'
const ENTRY_ID = 'dsh-force-subagent'

/** flat 下成员被禁止的委派工具（与 index.js 的 DELEGATION_TOOLS 同一份口径）。 */
const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'subagent_role', 'close_subagent', 'workflow']

function createSystemPrompt() {
  const sections = []
  return { sections, section: (definition) => { sections.push(definition) } }
}

function createCommands() {
  const registered = []
  return { registered, register: (definition) => { registered.push(definition) } }
}

function createHost({ agentTeams, settings } = {}) {
  const systemPrompt = createSystemPrompt()
  const commands = createCommands()
  const warnings = []
  const onCalls = []
  const ctx = {
    logger: { warn: (message) => { warnings.push(message) } },
    get: (service) => (
      service === 'systemPrompt' ? systemPrompt
        : service === 'commands' ? commands
          : service === 'agentTeams' ? agentTeams
            : service === 'settings' ? settings
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
  return { ctx, warnings, onCalls, systemPrompt, commands }
}

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })

/** 真实 TeamMembership 形状：role + root.session（Lead 会话），成员自身会话没有 command/run 记录。 */
const teammateAgent = (leadArgs) => ({
  session: { events: [] },
  notices: [],
  inject(message) { this.notices.push(message) },
  membership: { role: 'teammate', id: 'team-1', name: 'worker-1', root: { session: { events: [runEvent(leadArgs)] } } },
})

const leadAgent = (args) => ({ session: { events: [runEvent(args)] } })

const memberHost = () => createHost({ agentTeams: { tryMembership: (agent) => agent?.membership ?? undefined } })

function sectionOf(host) {
  assert.equal(host.systemPrompt.sections.length, 1, '必须恰好注册一个 systemPrompt section，不得为模式分支重复注册')
  return host.systemPrompt.sections[0]
}

const sectionText = (host, agent) => sectionOf(host).text({ agent })

const execOf = (name, agent) => ({
  callId: `call-${name}`,
  name,
  arguments: {},
  agent,
  signal: new AbortController().signal,
})

/** 调用真实注册的 tools/pre-execute 处理器，next 计数用于判定是否真的放行。 */
async function gateOutcome(host, exec) {
  const handlers = host.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)
  assert.ok(handlers.length >= 1, `apply 未注册 ctx.on('${GATE_EVENT}') 监听器`)
  let nextCalls = 0
  const decisions = []
  let threw
  try {
    for (const handler of handlers) decisions.push(await handler(exec, () => { nextCalls += 1 }))
  } catch (error) {
    threw = error
  }
  return { decisions, threw, nextCalls }
}

test('F) mode 归一化：非法取值回退 nested 且只 warn 一次', () => {
  const notes = []
  const warn = (detail) => { notes.push(detail) }
  assert.deepEqual(
    resolveConfig({ mode: 'bogus' }, warn),
    { ...DEFAULT_CONFIG, mode: 'nested' },
    '非法 mode 必须整体回退 nested 默认配置',
  )
  assert.equal(notes.length, 1, `非法 mode 必须 warn 恰好一次，实际 ${notes.length} 次：${notes.join(' | ')}`)
  resolveConfig({ mode: 'bogus' }, warn)
  resolveConfig({ mode: 42 }, warn)
  assert.equal(notes.length, 1, `warn-once 失效：多次非法取值仍继续刷屏告警`)
  assert.match(notes[0], /mode 取值非法/)
  assert.equal(resolveConfig({ mode: 'flat' }, warn).mode, 'flat')
  assert.equal(resolveConfig({ mode: 'nested' }, warn).mode, 'nested')
  assert.equal(resolveConfig({ mode: '' }, warn).mode, 'nested', '空串沿用 fallback')
  assert.equal(resolveConfig({ mode: null }, warn).mode, 'nested', 'null 沿用 fallback')
  assert.equal(resolveConfig(undefined, warn).mode, 'nested', '无配置沿用 fallback')
  assert.equal(notes.length, 1, '合法取值与缺省不得追加告警')
})

test('A) 无 mode 配置：默认 nested，提示词保持 nested 关键句、不混入 flat 措辞', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'nested', 'DEFAULT_CONFIG 必须声明 mode 默认值，否则宿主 projectForm 静默丢弃')
  const host = memberHost()
  apply(host.ctx)
  const member = sectionText(host, teammateAgent('on'))
  assert.match(member, /第一个业务工具调用必须是委派/)
  assert.match(member, /subagent/)
  assert.doesNotMatch(member, /flat/, 'nested 成员提示词不得出现 flat 措辞')
  const lead = sectionText(host, leadAgent('on'))
  assert.match(lead, /team_task_create/)
  assert.doesNotMatch(lead, /软踢出|没有删除成员的 API/, 'nested Lead 提示词不得混入 flat 软踢出段')
})

test('B) mode=flat：成员提示词整段换成 flat 版，nested 关键句与 team_task_create 字面量都不出现', () => {
  const host = memberHost()
  apply(host.ctx, { mode: 'flat' })
  const text = sectionText(host, teammateAgent('on'))
  assert.match(text, /flat 模式/, 'flat 成员提示词必须点名 flat 模式')
  assert.match(text, /你自己执行/, 'flat 成员提示词必须写明成员自己执行')
  assert.match(text, /只用成员、不派子代理/, 'flat 成员提示词必须声明本团队不派子代理')
  for (const tool of DELEGATION_TOOLS) {
    assert.ok(text.includes(tool), `flat 成员提示词必须点名被门禁拒绝的「${tool}」`)
  }
  assert.doesNotMatch(text, /第一个业务工具调用必须是委派/, 'flat 成员提示词不得保留 nested 委派关键句')
  assert.doesNotMatch(text, /必须委派|你只是编排者/, 'flat 成员提示词不得保留 nested 编排者措辞')
  assert.doesNotMatch(text, /team_task_create/, 'flat 成员提示词不得冒充 Lead 的看板登记指令')
  assert.match(text, /team_task_\*/, 'flat 成员提示词应以 team_task_* 泛指看板')
  assert.doesNotMatch(text, /深度≤2/, 'flat 模式没有下派层级，不得保留深度要求')
})

test('B2) mode=flat：Lead 提示词追加软踢出段（判定完成 → interrupt_agent + team_task_update → 不再 send_message）', () => {
  const host = memberHost()
  apply(host.ctx, { mode: 'flat' })
  const text = sectionText(host, leadAgent('on'))
  assert.match(text, /team_task_create/, 'flat 的 Lead 仍要建看板，nested 段不得被替换掉')
  assert.match(text, /判定该成员本次任务是否完成/, 'Lead 必须逐条成员消息先判定完成')
  assert.match(text, /interrupt_agent/, '完成必须 interrupt_agent 中断该成员')
  assert.match(text, /team_task_update/, '完成必须 team_task_update 关闭任务')
  assert.match(text, /不再向该成员 send_message|不再 send_message/, '完成后不得再 send_message / 复用')
  assert.match(text, /没有删除成员的 API/, '必须写明宿主没有删除成员 API')
  assert.match(text, /软踢出/, '必须写明这是软踢出而不是删除')
})

test('C) 实时配置优先：settings.describe() 的 mode 覆盖 apply 时的快照（改设置不必重启插件）', async () => {
  const host = createHost({
    agentTeams: { tryMembership: (agent) => agent?.membership ?? undefined },
    settings: { describe: () => [{ ns: ENTRY_ID, value: { mode: 'flat' } }] },
  })
  apply(host.ctx, { mode: 'nested' })
  const text = sectionText(host, teammateAgent('on'))
  assert.match(text, /flat 模式/, '实时 mode=flat 必须生效为 flat 提示词')
  assert.doesNotMatch(text, /第一个业务工具调用必须是委派/)
  const agent = teammateAgent('on')
  const { decisions, threw, nextCalls } = await gateOutcome(host, execOf('subagent', agent))
  assert.equal(threw, undefined)
  assert.equal(decisions.filter((d) => d?.kind === 'deny').length, 0, '实时 flat 下成员委派不得 deny')
  assert.equal(nextCalls, 1, 'flat 放行必须调用 next 一次')
  assert.equal(agent.notices.length, 1, '实时 flat 下成员委派必须投递一条提醒')
  assert.match(agent.notices[0]?.content?.[0]?.text ?? '', /flat 模式/, '提醒必须点明 flat 模式')
})

test('D) flat 门禁：成员调五个委派工具一律放行 + 提醒一次（文案点明 flat 模式与自己执行）', async () => {
  for (const tool of DELEGATION_TOOLS) {
    const host = memberHost()
    apply(host.ctx, { mode: 'flat' })
    const agent = teammateAgent('on')
    const { decisions, threw, nextCalls } = await gateOutcome(host, execOf(tool, agent))
    assert.equal(threw, undefined, `${tool}：flat 门禁不得抛异常，实际：${threw instanceof Error ? threw.message : String(threw)}`)
    assert.equal(decisions.filter((decision) => decision?.kind === 'deny').length, 0, `${tool}：flat 模式下成员委派不得 deny，实际 decisions=${JSON.stringify(decisions)}`)
    assert.equal(nextCalls, 1, `${tool}：放行路径必须恰好调用 next 一次，实际 ${nextCalls} 次`)
    assert.equal(agent.notices.length, 1, `${tool}：必须恰好投递一条提醒，实际 ${agent.notices.length} 条`)
    const text = agent.notices[0]?.content?.[0]?.text ?? ''
    assert.match(text, /flat 模式/, `${tool}：提醒文案必须点明 flat 模式`)
    assert.match(text, /自己执行/, `${tool}：提醒文案必须要求成员自己执行`)
    assert.match(text, new RegExp(`「${tool}」`), `${tool}：提醒文案必须点名被劝阻的工具`)
  }
})

test('E) flat 门禁：成员的 write / edit / bash / read 一律放行且不提醒，next 恰好一次', async () => {
  for (const tool of ['write', 'edit', 'bash', 'read', 'grep', 'glob', 'todo_write']) {
    const host = memberHost()
    apply(host.ctx, { mode: 'flat' })
    const agent = teammateAgent('on')
    const { decisions, threw, nextCalls } = await gateOutcome(host, execOf(tool, agent))
    assert.equal(threw, undefined, `${tool}：flat 门禁不得抛异常，实际：${threw instanceof Error ? threw.message : String(threw)}`)
    assert.equal(decisions.filter((decision) => decision?.kind === 'deny').length, 0, `${tool}：flat 模式成员自己执行的工具不得 deny，实际 ${JSON.stringify(decisions)}`)
    assert.equal(nextCalls, 1, `${tool}：放行路径必须恰好调用 next 一次，实际 ${nextCalls} 次`)
    assert.equal(agent.notices.length, 0, `${tool}：flat 下成员自己执行的工具不得投递提醒`)
  }
})

test('G) nested 口径不回归：成员 subagent 放行不提醒、成员 bash 放行但提醒一次', async () => {
  const nested = memberHost()
  apply(nested.ctx)
  const allowAgent = teammateAgent('on')
  const allow = await gateOutcome(nested, execOf('subagent', allowAgent))
  assert.equal(allow.threw, undefined)
  assert.equal(allow.decisions.filter((d) => d?.kind === 'deny').length, 0, 'nested 下成员委派不得 deny')
  assert.equal(allow.nextCalls, 1, `nested 放行必须恰好调用 next 一次，实际 ${allow.nextCalls} 次`)
  assert.equal(allowAgent.notices.length, 0, 'nested 下成员委派不得提醒')

  const denyHost = memberHost()
  apply(denyHost.ctx)
  const remindAgent = teammateAgent('on')
  const reminded = await gateOutcome(denyHost, execOf('bash', remindAgent))
  assert.equal(reminded.threw, undefined)
  assert.equal(reminded.decisions.filter((d) => d?.kind === 'deny').length, 0, 'nested 下成员执行类工具不得 deny（软门禁口径）')
  assert.equal(reminded.nextCalls, 1, `nested 放行必须调用 next 一次，实际 ${reminded.nextCalls} 次`)
  assert.equal(remindAgent.notices.length, 1, 'nested 下成员执行类工具必须提醒一次')
  assert.match(remindAgent.notices[0]?.content?.[0]?.text ?? '', /(委派|subagent)/, '提醒必须给出委派解法')
})

test('H) 非法 mode=flat 拼错（bogus）：门禁与提示词都按 nested 处理', async () => {
  const host = memberHost()
  apply(host.ctx, { mode: 'bogus' })
  const text = sectionText(host, teammateAgent('on'))
  assert.match(text, /第一个业务工具调用必须是委派/, '非法 mode 必须回退 nested 提示词')
  assert.doesNotMatch(text, /flat 模式/, '非法 mode 不得产出 flat 提示词')
  const allowAgent = teammateAgent('on')
  const allow = await gateOutcome(host, execOf('subagent', allowAgent))
  assert.equal(allow.nextCalls, 1, '非法 mode 下成员委派仍按 nested 放行')
  assert.equal(allowAgent.notices.length, 0, '非法 mode 回退 nested 后委派不得提醒')
  const bashAgent = teammateAgent('on')
  const reminded = await gateOutcome(host, execOf('bash', bashAgent))
  assert.equal(reminded.decisions.filter((d) => d?.kind === 'deny').length, 0, '非法 mode 下成员执行类工具按 nested 放行')
  assert.equal(reminded.nextCalls, 1, '非法 mode 下成员执行类工具必须调用 next')
  assert.equal(bashAgent.notices.length, 1, '非法 mode 回退 nested 后执行类工具必须提醒一次')
})

test('I) 模式只影响成员侧委派口径，Lead 取证门禁与 flat 无关的放行不变', async () => {
  const host = memberHost()
  apply(host.ctx, { mode: 'flat' })
  const { decisions, threw, nextCalls } = await gateOutcome(host, execOf('team_task_create', leadAgent('on')))
  assert.equal(threw, undefined)
  assert.equal(decisions.filter((d) => d?.kind === 'deny').length, 0, 'flat 不得把 Lead 的 team_task_create 拦掉')
  assert.equal(nextCalls, 1, `Lead 放行必须恰好调用 next 一次，实际 ${nextCalls} 次`)
})
