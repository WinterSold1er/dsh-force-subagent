/**
 * 契约验收：`/using-agent-team` 命令 + systemPrompt section 门控。
 *
 * 新契约（本轮改动，替代旧的「命令只有会话页可见一行」契约）：
 *  - 命令每次执行都投递一条模型可见的 user 消息：`{ id, role:'user',
 *    content:[{type:'text',text}], source:{ kind:'force-subagent', form:'notice',
 *    summary } }`；带 task 走 `agent.steer`，`on` / 裸命令 / `off` 走 `agent.inject`；
 *    `invocation.agent` 缺 steer/inject 时跳过不抛错，命令仍返回 success；
 *  - `<task>` 原文记入 `command/run` 事件，并持久出现在 section 文本里，直到 `off`。
 *
 * 宿主已验证的契约（Lead 裁决，旧 projection / 自定义事件方案作废）：
 *  - 命令 handler 只返回 `{ kind: 'success', text }`，不写状态、不在返回值里塞消息；
 *  - 宿主在命令被 invoke 后自行把执行记为 session 事件：`type: 'command/run'`，
 *    `data: { commandId, name, args?, source }`，进入 `session.events`；`args`
 *    保留用户原文（可能带前导空白），裸命令（recordInput:false）时无该字段；
 *  - 门控在 `systemPrompt.section({ name, order, text(context) })` 的 text 里：
 *    取 `context.agent.session`，倒序找最后一条 `type === 'command/run'` 且
 *    `data.name === 'using-agent-team'` 的事件；`data.args` 去空白转小写为
 *    `'off'` → `''`；空 / `on` → 单行提醒；其它原文 → 提醒 + 任务段（多行，含任务原文）；
 *    无记录 → `''`。真实 Session 只暴露 `snapshotEvents()`（无 `.events`），
 *    text 必须两条路径都兼容。
 *
 * 不 mock 被测逻辑：只捕获 apply(ctx) 真实注册的命令与 section，再用真实
 * session.events / snapshotEvents() 求值。命令调用走 invokeCommand：先调用真实
 * handler，再由 harness 模拟宿主把 command/run 落盘，禁止手工构造被测命令的事件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../../index.js'

const apply = plugin.apply ?? plugin.default?.apply
const NAME = 'using-agent-team'
const SECTION = 'force-subagent:agent-team'
const REMINDER = /using-agent-team|agent[-\s]?team|强制委派|委派/
const SIGNAL = new AbortController().signal

const newSession = () => ({ events: [] })
const agentOf = session => ({ session })

/**
 * 宿主在命令 invoke 后自行落盘的 `command/run` 事件。
 * 补齐事件保真字段 `source:{kind:'user'}` / `seq` / `time`；`args` 用 rawInput 原文。
 */
function hostCommandRun(rawInput, { seq = 1, omitArgs = false, time = '2026-10-31T00:00:00.000Z' } = {}) {
  const data = { commandId: 'c1', name: NAME, source: { kind: 'user' } }
  if (!omitArgs) data.args = rawInput
  return { type: 'command/run', source: { kind: 'user' }, seq, time, data }
}

/**
 * 最小 fake ctx：同时提供属性、get() 与 inject() 三条服务访问路径。
 * `gets` 记录 apply 期间所有 `ctx.get(name)` 调用，用于校验模块级 inject 依赖声明。
 */
function harness() {
  const commands = []
  const sections = []
  const listeners = []
  const gets = []
  const services = {
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
  }
  const ctx = {
    commands: services.commands,
    systemPrompt: services.systemPrompt,
    get(name) {
      gets.push(name)
      return services[name]
    },
    inject(deps, callback) {
      callback(ctx)
      return () => {}
    },
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    logger: { warn() {} },
  }
  return { ctx, commands, sections, listeners, gets }
}

/** 执行真实 apply（兼容 sync/async）并断言命令与 section 各注册一次。 */
async function boot() {
  const h = harness()
  await apply(h.ctx)
  assert.equal(h.commands.length, 1, '必须恰注册一个命令')
  assert.equal(h.sections.length, 1, '必须恰注册一个 systemPrompt section')
  assert.equal(h.sections[0].name, SECTION, 'section 名必须稳定')
  assert.equal(typeof h.sections[0].text, 'function', 'section.text 必须是 context 函数')
  return h
}

/**
 * 调用真实命令 handler，然后由 harness 模拟宿主向 session 日志追加 command/run
 * （宿主在 handler 返回之后才落盘，故不可变用例另行直调 handler）。
 * @returns {Promise<unknown>} handler 的原始返回值。
 */
async function invokeCommand(def, agent, rawInput, options = {}) {
  const result = await def.handler({
    commandId: 'c1',
    agent,
    rawInput,
    attachments: [],
    signal: SIGNAL,
  })
  agent.session.events.push(
    hostCommandRun(rawInput, { seq: agent.session.events.length + 1, ...options }),
  )
  return result
}

const prompt = (h, session) => h.sections[0].text({ agent: { session } })

test('T1 命令注册名精确为 using-agent-team', async () => {
  const h = await boot()
  assert.equal(h.commands[0].name, NAME)
  assert.equal(typeof h.commands[0].handler, 'function')
})

test('T2 新 session 未 invoke → 空串', async () => {
  const h = await boot()
  assert.equal(prompt(h, newSession()), '')
})

test('T3 invoke 后同一 session → 提醒含关键词与任务原文；裸命令仍单行', async () => {
  const h = await boot()
  const agent = agentOf(newSession())
  await invokeCommand(h.commands[0], agent, '修 bug')
  const text = prompt(h, agent.session)
  assert.ok(text.trim().length > 0, '提醒必须非空')
  assert.match(text, REMINDER)
  assert.match(text, /本会话任务/, '带 task 必须出现任务段')
  assert.ok(text.includes('修 bug'), '任务原文必须持久在 section 文本里')

  const bare = agentOf(newSession())
  await invokeCommand(h.commands[0], bare, '')
  assert.equal(prompt(h, bare.session).split('\n').length, 1, '无 task 的提醒必须恰一行')
  assert.doesNotMatch(prompt(h, bare.session), /本会话任务/, '无 task 不得出现任务段')
})

test('T4 args 为 off（含大小写/前导空白）→ 空串', async () => {
  const h = await boot()
  for (const args of ['off', ' OFF ', 'Off', ' off', '\toff\n']) {
    const agent = agentOf(newSession())
    await invokeCommand(h.commands[0], agent, args)
    assert.equal(prompt(h, agent.session), '', `args=${JSON.stringify(args)} 必须关闭`)
  }
})

test('T5 最后一条记录生效：on → off → on', async () => {
  const h = await boot()
  const agent = agentOf(newSession())
  await invokeCommand(h.commands[0], agent, '修 bug')
  assert.notEqual(prompt(h, agent.session), '', '首次 on 必须开启')
  await invokeCommand(h.commands[0], agent, 'off')
  assert.equal(prompt(h, agent.session), '', 'on→off 必须关闭')
  await invokeCommand(h.commands[0], agent, 'on')
  assert.notEqual(prompt(h, agent.session), '', 'off→on 必须开启（取最后一条）')
})

test('T6 无关命令（clear）不触发', async () => {
  const h = await boot()
  const session = newSession()
  session.events.push({
    type: 'command/run',
    source: { kind: 'user' },
    seq: 1,
    time: '2026-10-31T00:00:00.000Z',
    data: { commandId: 'c2', name: 'clear', source: { kind: 'user' } },
  })
  assert.equal(prompt(h, session), '', '无关命令必须不触发')
})

test('T7 会话隔离（双向）：B 先 on 不影响 A；A on、B on→off 后 A 仍开', async () => {
  const h = await boot()
  const a = agentOf(newSession())
  const b = agentOf(newSession())
  await invokeCommand(h.commands[0], b, 'on')
  assert.equal(prompt(h, a.session), '', 'B 先 on 时 A 无记录必须关闭')
  assert.notEqual(prompt(h, b.session), '', 'B 有记录必须开启')
  await invokeCommand(h.commands[0], a, 'on')
  await invokeCommand(h.commands[0], b, 'off')
  assert.notEqual(prompt(h, a.session), '', 'A on 后必须开启')
  assert.equal(prompt(h, b.session), '', 'B off 后必须关闭')
})

test('T8 幂等：重复 invoke 不叠加', async () => {
  const h = await boot()
  for (const rawInput of ['', '修 bug']) {
    const once = agentOf(newSession())
    await invokeCommand(h.commands[0], once, rawInput)
    const expected = prompt(h, once.session)

    const twice = agentOf(newSession())
    await invokeCommand(h.commands[0], twice, rawInput)
    await invokeCommand(h.commands[0], twice, rawInput)
    assert.equal(
      prompt(h, twice.session),
      expected,
      `rawInput=${JSON.stringify(rawInput)} 重复 invoke 必须逐字相等`,
    )
  }
})

test('T9 handler 返回 success 且 text 非空', async () => {
  const h = await boot()
  const result = await invokeCommand(h.commands[0], agentOf(newSession()), '')
  assert.equal(result.kind, 'success')
  assert.equal(typeof result.text, 'string')
  assert.ok(result.text.trim().length > 0)
})

test('T10 无伪造注入：未注册 agent/pre-step，返回值里不含消息（投递走 agent.steer/inject）', async () => {
  const h = await boot()
  assert.equal(
    h.listeners.some(({ event }) => event === 'agent/pre-step'),
    false,
    '不得注册 agent/pre-step',
  )
  const result = await invokeCommand(h.commands[0], agentOf(newSession()), '')
  assert.equal('messages' in result, false, 'handler 不得返回伪造消息')
  assert.equal(JSON.stringify(result).includes('"role":"user"'), false, '不得伪造 user 消息')
})

test('T11 诊断路径：context 缺 agent/session 时 text 返回空串且不抛', async () => {
  const h = await boot()
  const text = h.sections[0].text
  const cases = [
    ['无 agent 键', {}],
    ['agent 为 undefined', { agent: undefined }],
    ['session 为 undefined', { agent: { session: undefined } }],
  ]
  // 抛异常会直接让本测试失败，故只需断言返回值。
  for (const [label, context] of cases) {
    assert.equal(text(context), '', `${label} 必须返回空串`)
  }
})

test('T12 snapshotEvents 路径：无 .events、返回值被冻结', async () => {
  const h = await boot()
  const log = []
  const session = { snapshotEvents: () => Object.freeze([...log]) }
  assert.equal('events' in session, false, '该 session 不得暴露 .events')
  assert.equal(prompt(h, session), '', '无记录必须空串')

  log.push(hostCommandRun('修 bug', { seq: 1 }))
  const enabled = prompt(h, session)
  assert.notEqual(enabled, '', 'snapshotEvents 有 on 记录必须开启')
  assert.match(enabled.trim(), REMINDER)

  log.push(hostCommandRun(' off', { seq: 2 }))
  assert.equal(prompt(h, session), '', "snapshotEvents 路径 args=' off' 必须关闭")

  log.push(hostCommandRun('on', { seq: 3 }))
  assert.match(prompt(h, session).trim(), REMINDER, 'off→on 必须重新开启')
})

test('T13 依赖声明：apply 期间 get 的服务全部在模块 inject 数组内', async () => {
  const h = await boot()
  assert.ok(h.gets.length > 0, 'apply 必须经 ctx.get 取服务')
  assert.ok(
    Array.isArray(plugin.inject),
    `模块必须导出 inject 数组声明依赖，实际类型为 ${typeof plugin.inject}`,
  )
  for (const serviceName of new Set(h.gets)) {
    assert.ok(
      plugin.inject.includes(serviceName),
      `ctx.get('${serviceName}') 未在 plugin.inject 中声明`,
    )
  }
})

test('T14 不可变：handler 不写 session 日志、不改写 agent', async () => {
  const h = await boot()
  const session = newSession()
  const agent = { id: 'agent-1', role: 'lead', session }
  const beforeLength = session.events.length
  const before = {
    id: agent.id,
    role: agent.role,
    session: agent.session,
    keys: Object.keys(agent),
  }
  const result = await h.commands[0].handler({
    commandId: 'c1',
    agent,
    rawInput: '修 bug',
    attachments: [],
    signal: SIGNAL,
  })
  assert.equal(
    session.events.length,
    beforeLength,
    'handler 不得向 session.events 写事件（宿主在 handler 返回后落盘）',
  )
  assert.equal(agent.id, before.id)
  assert.equal(agent.role, before.role)
  assert.equal(agent.session, before.session, 'session 引用不得被替换')
  assert.deepEqual(Object.keys(agent), before.keys, 'agent 不得被新增/删除字段')
  assert.equal(result.kind, 'success')
})

test('T15 裸命令：data 无 args 字段与 args:"" 都必须开启', async () => {
  const h = await boot()
  const bare = agentOf(newSession())
  const bareResult = await h.commands[0].handler({
    commandId: 'c1',
    agent: bare,
    rawInput: '',
    attachments: [],
    signal: SIGNAL,
  })
  assert.equal(bareResult.kind, 'success')
  assert.ok(bareResult.text.trim().length > 0, '裸命令 handler 文案必须非空')
  const event = hostCommandRun('', { seq: 1, omitArgs: true })
  assert.equal('args' in event.data, false, '该宿主事件必须不带 args 字段')
  bare.session.events.push(event)
  assert.notEqual(prompt(h, bare.session), '', '无 args 字段必须视为开启')

  const empty = agentOf(newSession())
  await invokeCommand(h.commands[0], empty, '')
  assert.notEqual(prompt(h, empty.session), '', "args:'' 必须视为开启")
})

test("T16 handler on/off 文案语义：on 与 off 都必须成功且文案互斥", async () => {
  const h = await boot()
  const on = await h.commands[0].handler({
    commandId: 'c1',
    agent: agentOf(newSession()),
    rawInput: '',
    attachments: [],
    signal: SIGNAL,
  })
  const off = await h.commands[0].handler({
    commandId: 'c2',
    agent: agentOf(newSession()),
    rawInput: 'off',
    attachments: [],
    signal: SIGNAL,
  })
  assert.equal(on.kind, 'success', 'on 必须返回 success')
  assert.equal(off.kind, 'success', 'off 必须返回 success')
  assert.equal(typeof on.text, 'string', 'on 文案必须是 string')
  assert.equal(typeof off.text, 'string', 'off 文案必须是 string')
  assert.ok(on.text.trim().length > 0, 'on 文案必须非空')
  assert.ok(off.text.trim().length > 0, 'off 文案必须非空')
  assert.notEqual(on.text, off.text, 'on/off 文案必须给出相反语义，不得相同')
  assert.match(on.text, /开启|启用|委派/, 'on 文案必须表达开启/启用/委派')
  assert.match(off.text, /关闭|off/i, 'off 文案必须表达关闭')
  // 判别性断言：上面两条正则会被两句文案共有的「强制委派」字样同时满足，无法发现 on/off 文案互换。
  assert.match(on.text, /已开启/, 'on 文案必须明确说“已开启”')
  assert.doesNotMatch(off.text, /开启|启用/, 'off 文案不得出现开启/启用语义')
})

test('T17 handler 返回形状防漂移：恒为 { kind, text } 对象', async () => {
  const h = await boot()
  for (const rawInput of ['', 'off']) {
    const result = await h.commands[0].handler({
      commandId: 'c1',
      agent: agentOf(newSession()),
      rawInput,
      attachments: [],
      signal: SIGNAL,
    })
    const label = rawInput === '' ? "args:''" : "args:'off'"
    assert.equal(typeof result, 'object', `${label} 返回值必须是对象`)
    assert.notEqual(result, null, `${label} 返回值不得为 null`)
    assert.equal(Array.isArray(result), false, `${label} 返回值不得是数组`)
    assert.ok(['success', 'error'].includes(result.kind), `${label} kind 必须是 success 或 error`)
    assert.equal(typeof result.text, 'string', `${label} text 必须是 string`)
    assert.ok(result.text.trim().length > 0, `${label} text 必须非空（error 时也不得为空）`)
  }
})

test('T18 每次 invoke 都投递模型可见 notice：带 task 走 steer，其余走 inject', async () => {
  const h = await boot()
  const sent = { steer: [], inject: [] }
  const agent = {
    ...agentOf(newSession()),
    steer: (message) => sent.steer.push(message),
    inject: (message) => sent.inject.push(message),
  }

  await invokeCommand(h.commands[0], agent, '修 bug')
  assert.deepEqual([sent.steer.length, sent.inject.length], [1, 0], '带 task 必须恰好 steer 一次')
  const [notice] = sent.steer
  assert.equal(notice.role, 'user', '注入必须落在 user 角色')
  assert.equal(notice.source.kind, 'force-subagent')
  assert.equal(notice.source.form, 'notice')
  assert.equal(notice.source.summary, '已开启强制委派：修 bug')
  assert.equal(notice.content.length, 1)
  assert.equal(notice.content[0].type, 'text')
  assert.ok(notice.content[0].text.includes('修 bug'), '提醒必须携带任务原文')
  assert.match(notice.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '消息必须有 UUID id')

  await invokeCommand(h.commands[0], agent, 'on')
  await invokeCommand(h.commands[0], agent, 'off')
  assert.equal(sent.steer.length, 1, '无 task 与 off 都不得 steer')
  assert.deepEqual(sent.inject.map((message) => message.source.summary), ['已开启强制委派', '已关闭强制委派'])
  assert.match(sent.inject[1].content[0].text, /不再强制委派/, 'off 的 notice 必须说明已关闭')
  assert.equal(prompt(h, agent.session), '', 'off 后 section 必须回到空串')
})
