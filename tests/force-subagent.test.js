/**
 * dsh-force-subagent 行为测试：命令门控从宿主 `command/run` 事件派生，无 pre-step、无状态。
 * 运行：node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply, parseCommandInput } = plugin

function createSystemPrompt() {
  const sections = []
  return {
    sections,
    section(definition) {
      sections.push(definition)
    },
  }
}

function createCommands() {
  const registered = []
  return {
    registered,
    register(definition) {
      registered.push(definition)
    },
  }
}

function createHost({ systemPrompt = createSystemPrompt(), commands = createCommands(), agentTeams } = {}) {
  const warnings = []
  const onCalls = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    get: (service) => (service === 'systemPrompt' ? systemPrompt : service === 'commands' ? commands : service === 'agentTeams' ? agentTeams : undefined),
    on: (...args) => {
      onCalls.push(args)
    },
    effect: (factory) => factory(),
    fiber: { uid: 'test-fiber' },
    settings: { configure: () => () => {} },
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: ctx.fiber ?? { uid: 'test-fiber' },
      settings: ctx.settings ?? { configure: () => () => {} },
      logger: ctx.logger,
    }),
  }
  return { ctx, warnings, onCalls, systemPrompt, commands, agentTeams }
}

const runEvent = (name, args) => ({
  type: 'command/run',
  data: args === undefined ? { name } : { name, args },
})

function sectionOf(host) {
  assert.equal(host.systemPrompt.sections.length, 1, '必须恰好注册一个 systemPrompt section')
  return host.systemPrompt.sections[0]
}

const textFor = (host, session) => sectionOf(host).text({ agent: { session } })

test('apply 注册命令与 systemPrompt section，声明 inject、不监听 agent/pre-step', () => {
  const host = createHost()
  apply(host.ctx)

  assert.equal(plugin.name, 'force-subagent')
  assert.deepEqual(plugin.inject, ['commands', 'systemPrompt', 'subagents'], '必须声明 inject 让 Cordis 门控 apply')

  const section = sectionOf(host)
  assert.equal(section.name, 'force-subagent:agent-team')
  assert.ok(section.order >= 0 && section.order <= 999)
  assert.equal(typeof section.text, 'function')

  assert.equal(host.commands.registered.length, 1)
  const definition = host.commands.registered[0]
  assert.equal(definition.name, 'using-agent-team')
  assert.match(definition.description, /Agent-Team 强制委派/)
  assert.match(definition.description, /\/using-agent-team off/)
  assert.equal(definition.input.hint, '<task> | on | off')
  assert.equal(typeof definition.handler, 'function')

  assert.equal(host.onCalls.filter(([event]) => event === 'agent/pre-step').length, 0, '不得再注册 agent/pre-step 监听')
})

test('handler 返回会话页可见的 success 行；off 返回关闭确认', () => {
  const host = createHost()
  apply(host.ctx)
  const { handler } = host.commands.registered[0]

  const enabled = handler({ rawInput: ' 写一个解析器 ' })
  assert.equal(enabled.kind, 'success')
  assert.equal(typeof enabled.text, 'string')
  assert.match(enabled.text, /\/using-agent-team off/)

  const explicitOn = handler({ rawInput: 'on' })
  assert.equal(explicitOn.kind, 'success')

  const disabled = handler({ rawInput: '  OFF  ' })
  assert.equal(disabled.kind, 'success')
  assert.doesNotMatch(disabled.text, /已开启/, 'off 分支不得复用 on 分支措辞')
  assert.notEqual(disabled.text, explicitOn.text, 'off 与 on 的返回文案必须不同')
})

test('无 command/run 记录的普通会话：text 返回空串', () => {
  const host = createHost()
  apply(host.ctx)
  assert.equal(textFor(host, { events: [] }), '')
})

test('最后一条 using-agent-team 记录为 on/task：text 非空', () => {
  const host = createHost()
  apply(host.ctx)
  const text = textFor(host, { events: [runEvent('using-agent-team', 'on')] })
  assert.ok(text.length > 0)
  assert.match(text, /Agent-Team/)
  assert.match(text, /team_task_create/)
})

test('未带 args（直接 /using-agent-team）：视为开启', () => {
  const host = createHost()
  apply(host.ctx)
  assert.ok(textFor(host, { events: [runEvent('using-agent-team')] }).length > 0)
})

test('最后一条记录为 off：text 返回空串（大小写/空格不敏感）', () => {
  const host = createHost()
  apply(host.ctx)
  assert.equal(textFor(host, { events: [runEvent('using-agent-team', ' OFF ')] }), '')
})

test('只认 using-agent-team，其它命令记录不触发', () => {
  const host = createHost()
  apply(host.ctx)
  assert.equal(textFor(host, { events: [runEvent('orchestrate', 'on'), runEvent('using-subagents', 'on')] }), '')
})

test('以最后一条 using-agent-team 记录为准：先 on 后 off 不注入，先 off 后 on 注入', () => {
  const host = createHost()
  apply(host.ctx)

  assert.equal(textFor(host, {
    events: [runEvent('using-agent-team', 'on'), runEvent('using-agent-team', 'off')],
  }), '')

  assert.ok(textFor(host, {
    events: [runEvent('using-agent-team', 'off'), runEvent('using-agent-team', 'task')],
  }).length > 0)
})

test('会话隔离：A 开启不影响 B；B 自己开启后才有提示', () => {
  const host = createHost()
  apply(host.ctx)

  const sessionA = { events: [runEvent('using-agent-team', 'on')] }
  const sessionB = { events: [] }

  assert.ok(textFor(host, sessionA).length > 0)
  assert.equal(textFor(host, sessionB), '')
  assert.ok(textFor(host, { events: [runEvent('using-agent-team', 'on')] }).length > 0)
})

test('context.agent 路径注入提醒（session 兜底已移除）', () => {
  const host = createHost()
  apply(host.ctx)
  const text = sectionOf(host).text({
    agent: { session: { snapshotEvents: () => [runEvent('using-agent-team', 'on')] } },
  })
  assert.ok(text.length > 0)
  assert.match(text, /委派/)
})

test('真实 Session 形态：私有日志通过 snapshotEvents() 读取', () => {
  const host = createHost()
  apply(host.ctx)
  const session = { snapshotEvents: () => [runEvent('using-agent-team', 'on')] }
  assert.ok(textFor(host, session).length > 0)
})

test('会话形状异常：返回空串且 logger.warn 记录异常（不空 catch）', () => {
  const host = createHost()
  apply(host.ctx)
  assert.equal(textFor(host, { events: 'not-an-array' }), '')
  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /读取会话事件失败/)

  const throwing = { snapshotEvents: () => { throw new Error('snapshot exploded') } }
  assert.equal(textFor(host, throwing), '')
  assert.equal(host.warnings.length, 2)
  assert.match(host.warnings[1], /snapshot exploded/)
})

test('无 session 上下文：返回空串且不告警', () => {
  const host = createHost()
  apply(host.ctx)
  assert.equal(sectionOf(host).text({}), '')
  assert.equal(host.warnings.length, 0)
})

const teammateAgent = (leadEvents, ownEvents = []) => ({
  session: { events: ownEvents },
  membership: { role: 'teammate', root: { session: { events: leadEvents } } },
})

const teammateHost = () => createHost({ agentTeams: { tryMembership: (agent) => agent.membership } })

test('成员：Lead 会话已开启时自动注入成员提醒（不依赖 Lead 手动提醒）', () => {
  const host = teammateHost()
  apply(host.ctx)
  const text = sectionOf(host).text({ agent: teammateAgent([runEvent('using-agent-team')]) })
  assert.match(text, /成员/)
  assert.match(text, /subagent/)
  assert.match(text, /第一个业务工具调用必须是委派/)
  assert.doesNotMatch(text, /team_task_create/, '成员提醒不得冒充 Lead 指令')
})

test('成员：Lead 未开启或已 off 时不注入', () => {
  const host = teammateHost()
  apply(host.ctx)
  assert.equal(sectionOf(host).text({ agent: teammateAgent([]) }), '')
  assert.equal(sectionOf(host).text({ agent: teammateAgent([runEvent('using-agent-team', 'off')]) }), '')
  assert.equal(sectionOf(host).text({ agent: teammateAgent([runEvent('using-agent-team', 'on'), runEvent('using-agent-team', 'off')]) }), '')
})

test('成员判定优先于自身记录：成员自身有 on 但 Lead 未开启仍不注入', () => {
  const host = teammateHost()
  apply(host.ctx)
  const agent = teammateAgent([], [runEvent('using-agent-team', 'on')])
  assert.equal(sectionOf(host).text({ agent }), '')
})

test('Lead 身份（role=lead）仍按自身会话门控，注入 Lead 版提醒', () => {
  const host = teammateHost()
  apply(host.ctx)
  const agent = {
    session: { events: [runEvent('using-agent-team')] },
    membership: { role: 'lead', root: { session: { events: [] } } },
  }
  assert.match(sectionOf(host).text({ agent }), /team_task_create/)
})

test('成员：无 agentTeams 服务时退回本会话门控，不误判为成员', () => {
  const host = createHost()
  apply(host.ctx)
  const text = sectionOf(host).text({ agent: { session: { events: [runEvent('using-agent-team')] } } })
  assert.match(text, /team_task_create/)
})

test('成员：Lead 会话读取异常 → warn 且不注入', () => {
  const host = teammateHost()
  apply(host.ctx)
  const agent = {
    session: { events: [] },
    membership: {
      role: 'teammate',
      root: { session: { snapshotEvents: () => { throw new Error('lead snapshot exploded') } } },
    },
  }
  assert.equal(sectionOf(host).text({ agent }), '')
  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /lead snapshot exploded/)
})

test('命令撞名 already registered：warn 含命令名与修复步骤，section 仍注册', () => {
  const conflicting = {
    register() {
      throw new Error('command "using-agent-team" is already registered (for a per-agent variant, mount a command-injected plugin under that agent\'s `agent.ctx`)')
    },
  }
  const host = createHost({ commands: conflicting })
  apply(host.ctx)

  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /using-agent-team/)
  assert.match(host.warnings[0], /dsh-plugin-subagent-director/)
  assert.match(host.warnings[0], /升级/)
  assert.equal(host.systemPrompt.sections.length, 1, '命令失败不得阻断 systemPrompt 注册')
})

test('命令注册的其它错误必须原样抛出，不得吞掉', () => {
  const broken = { register() { throw new Error('boom: disk on fire') } }
  const host = createHost({ commands: broken })
  assert.throws(() => apply(host.ctx), /boom: disk on fire/)
})

test('systemPrompt.section 撞名 already registered：warn 含 section 名，命令仍注册且 handler 返回 success', () => {
  const conflicting = {
    section() {
      throw new Error('section "force-subagent:agent-team" is already registered')
    },
  }
  const host = createHost({ systemPrompt: conflicting })
  apply(host.ctx)

  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /force-subagent:agent-team/)
  assert.equal(host.commands.registered.length, 1, 'section 失败不得阻断命令注册')
  assert.equal(host.commands.registered[0].name, 'using-agent-team')
  assert.equal(host.commands.registered[0].handler({ rawInput: 'on' }).kind, 'success')
})

test('systemPrompt.section 注册的其它错误必须原样抛出，不得吞掉', () => {
  const broken = {
    section() {
      throw new Error('boom: section exploded')
    },
  }
  const host = createHost({ systemPrompt: broken })
  assert.throws(() => apply(host.ctx), /boom: section exploded/)
  assert.equal(host.commands.registered.length, 0, 'section 抛错后不得继续注册命令')
})

test('parseCommandInput：空串与 on（含大小写/空白）开启且无 task，off 关闭，其它文本带 task 原文', () => {
  assert.deepEqual(parseCommandInput(undefined), { enabled: true })
  assert.deepEqual(parseCommandInput('   '), { enabled: true })
  assert.deepEqual(parseCommandInput('ON'), { enabled: true })
  assert.deepEqual(parseCommandInput(' off '), { enabled: false })
  assert.deepEqual(parseCommandInput('OFF'), { enabled: false })
  assert.deepEqual(parseCommandInput(' 写一个解析器 '), { enabled: true, task: '写一个解析器' })
  assert.deepEqual(parseCommandInput('offline 部署手册'), { enabled: true, task: 'offline 部署手册' }, 'off 前缀文本不得被当作关闭')
})

test('section 文本：开启带 task 时追加任务段并保留 Lead 指令', () => {
  const host = createHost()
  apply(host.ctx)
  const text = textFor(host, { events: [runEvent('using-agent-team', '写一个解析器')] })
  assert.match(text, /team_task_create/, '任务段不得顶掉 Lead 指令')
  assert.match(text, /本会话任务/)
  assert.ok(text.includes('写一个解析器'), 'section 必须持久携带任务原文')
  assert.ok(text.indexOf('本会话任务') > text.indexOf('team_task_create'), '任务段必须跟在 nudge 之后')
})

test('section 文本：开启无 task 与关闭时都不出现任务段', () => {
  const host = createHost()
  apply(host.ctx)
  assert.doesNotMatch(textFor(host, { events: [runEvent('using-agent-team', 'on')] }), /本会话任务/)
  assert.equal(textFor(host, { events: [runEvent('using-agent-team', 'off')] }), '')
})

const recordingAgent = () => {
  const sent = { steer: [], inject: [] }
  return {
    agent: {
      session: { events: [] },
      steer: (message) => sent.steer.push(message),
      inject: (message) => sent.inject.push(message),
    },
    sent,
  }
}

test('handler 带 task：steer 恰好一次、inject 零次，消息为 user notice 且含任务原文', () => {
  const host = createHost()
  apply(host.ctx)
  const { handler } = host.commands.registered[0]
  const { agent, sent } = recordingAgent()
  const result = handler({ rawInput: ' 写一个解析器 ', agent })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /任务已转交给模型/)
  assert.equal(sent.steer.length, 1, '带 task 必须恰好 steer 一次')
  assert.equal(sent.inject.length, 0, '带 task 不得走 inject')

  const message = sent.steer[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'force-subagent')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.summary, '已开启强制委派：写一个解析器')
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0].type, 'text')
  assert.match(message.content[0].text, /【强制委派提醒】/)
  assert.ok(message.content[0].text.includes('写一个解析器'), '提醒必须携带任务原文')
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '消息必须有 UUID id')
})

test('handler 无 task（裸命令 / on）：inject 一次、steer 零次，提醒说明持续到 off', () => {
  const host = createHost()
  apply(host.ctx)
  const { handler } = host.commands.registered[0]
  for (const rawInput of ['', 'on']) {
    const { agent, sent } = recordingAgent()
    const result = handler({ rawInput, agent })
    assert.equal(result.kind, 'success', `rawInput=${JSON.stringify(rawInput)} 必须成功`)
    assert.equal(sent.inject.length, 1, `rawInput=${JSON.stringify(rawInput)} 必须 inject 一次`)
    assert.equal(sent.steer.length, 0, '无 task 不得 steer 唤醒')
    assert.match(sent.inject[0].content[0].text, /持续到 \/using-agent-team off/)
    assert.equal(sent.inject[0].source.summary, '已开启强制委派')
  }
})

test('handler off：inject 一次关闭提醒且文案表达关闭', () => {
  const host = createHost()
  apply(host.ctx)
  const { handler } = host.commands.registered[0]
  const { agent, sent } = recordingAgent()
  const result = handler({ rawInput: 'off', agent })

  assert.equal(result.kind, 'success')
  assert.equal(sent.inject.length, 1)
  assert.equal(sent.steer.length, 0)
  assert.match(sent.inject[0].content[0].text, /【强制委派提醒已关闭】/)
  assert.equal(sent.inject[0].source.summary, '已关闭强制委派')
})

test('handler：agent 缺失 steer/inject 时跳过投递，仍 success 且不 warn', () => {
  const host = createHost()
  apply(host.ctx)
  const { handler } = host.commands.registered[0]

  assert.equal(handler({ rawInput: '修 bug' }).kind, 'success', 'invocation.agent 缺失不得抛错')
  assert.equal(handler({ rawInput: '修 bug', agent: { session: { events: [] } } }).kind, 'success')
  assert.equal(handler({ rawInput: 'off', agent: { inject: 'not-a-function' } }).kind, 'success')
  assert.equal(host.warnings.length, 0, '方法缺失属正常跳过，不得 warn')
})

test('handler：steer / inject 抛错时各 warn 一次并仍返回 success（不空 catch）', () => {
  const host = createHost()
  apply(host.ctx)
  const { handler } = host.commands.registered[0]

  assert.equal(handler({ rawInput: 'off', agent: { inject() { throw new Error('inject exploded') } } }).kind, 'success')
  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /inject exploded/)
  assert.match(host.warnings[0], /\[force-subagent\] 模型可见提醒投递（agent\.inject）失败/)

  assert.equal(handler({ rawInput: '修 bug', agent: { steer() { throw new Error('steer exploded') } } }).kind, 'success')
  assert.equal(host.warnings.length, 2)
  assert.match(host.warnings[1], /steer exploded/)
})

test('handler 已开启会话再次执行：每次都再投递一条新 notice（重复 steer）', () => {
  const host = createHost()
  apply(host.ctx)
  const { handler } = host.commands.registered[0]
  const { agent, sent } = recordingAgent()

  handler({ rawInput: '修 bug', agent })
  handler({ rawInput: '修 bug', agent })
  assert.equal(sent.steer.length, 2, '已开启会话再次下达任务必须再 steer 一次')
  assert.notEqual(sent.steer[0].id, sent.steer[1].id, '每次投递必须是不同的消息 id')

  agent.session.events.push(runEvent('using-agent-team', '修 bug'))
  assert.equal(textFor(host, agent.session).split('本会话任务').length, 2, 'section 必须只出现一个任务段，不得叠加')
})

test('成员会话：Lead 下达的 task 也出现在成员 section 文本里', () => {
  const host = teammateHost()
  apply(host.ctx)
  const text = sectionOf(host).text({ agent: teammateAgent([runEvent('using-agent-team', '写一个解析器')]) })
  assert.match(text, /成员/)
  assert.match(text, /本会话任务/)
  assert.ok(text.includes('写一个解析器'), '成员必须看到 Lead 的任务原文')
  assert.doesNotMatch(text, /team_task_create/, '成员文本不得混入 Lead 指令')
})
