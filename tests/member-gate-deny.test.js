/**
 * dsh-force-subagent 成员门禁「拒绝」侧测试（默认拒绝白名单口径）。
 * 契约：apply() 注册 ctx.on('tools/pre-execute', (exec, next) => ...)；
 * 成员 = ctx.get('agentTeams').tryMembership(exec.agent) 且 membership.role === 'teammate'；
 * 门禁生效条件 = membership.root.session 的最后一次 command/run（using-agent-team）事件 args 非 off；
 * 生效时白名单（subagent / subagent_fork / subagent_role / close_subagent / workflow / team_task 系列 /
 * send_message / wait_agent / list_agents / interrupt_agent / job 系列 / skill / todo_write / read / grep / glob）
 * 之外的一切工具必须 deny。
 * deny 断言口径：decision.kind === 'deny'、reason 为 string 且含「委派」或「subagent」、next 未被调用（nextCalls === 0）。
 * 边界断言口径：不得 deny，且 next 恰好被调用一次。
 * 与 tests/member-gate-allow.test.js 互补：那边测「不该 deny 的确实不 deny」，本文件测「该 deny 的确实 deny 且真拦住」。
 * 运行：node --test tests/member-gate-deny.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'

/** 白名单外必须 deny 的工具（执行类与对外副作用类）。 */
const DENY_TOOLS = [
  'bash',
  'edit',
  'write',
  'web_search',
  'web_fetch',
  'run_code',
  'pwsh',
  'terminal_open',
  'terminal_send',
  'str_replace_editor',
  'create_skill',
  'caveman_browse',
  'create_worktree',
  'lsp',
  'spawn_teammate',
  'ask_user_question',
  'present',
  'update_goal',
  'mcp__github__get_me',
  'mcp__telegram__any',
]

function createHost({ agentTeams } = {}) {
  const onCalls = []
  const ctx = {
    logger: { warn: () => {} },
    get: (service) => (service === 'agentTeams' ? agentTeams : undefined),
    on: (...args) => {
      onCalls.push(args)
    },
  }
  return { ctx, onCalls }
}

/** Lead 会话事件：真实形状是 snapshotEvents()，args 为命令原始输入。 */
const leadSession = (args) => ({
  snapshotEvents: () => [{ type: 'command/run', data: { name: COMMAND_NAME, args } }],
})

/** 真实 TeamMembership 形状：role + id + name + root.session，不是 return true 空壳。 */
const membershipOf = (role, args) => ({
  role,
  id: 'team-1',
  name: role === 'teammate' ? 'worker-1' : 'lead-1',
  root: { session: leadSession(args) },
})

const agentOf = (membership) => ({
  session: { snapshotEvents: () => [] },
  membership,
})

const memberHost = (membership) =>
  createHost({ agentTeams: { tryMembership: (agent) => agent?.membership ?? undefined } })

const gateHandlers = (host) =>
  host.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)

const execOf = (name, agent) => ({
  callId: `call-${name}`,
  name,
  arguments: {},
  agent,
  signal: new AbortController().signal,
})

/** 调用真实注册的处理器链（非 mock 自身），next 计数用于判定拦截是否真的生效。 */
async function gateOutcome(host, exec) {
  const handlers = gateHandlers(host)
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
  }
  const decisions = []
  let threw
  try {
    for (const handler of handlers) decisions.push(await handler(exec, next))
  } catch (error) {
    threw = error
  }
  return { decisions, threw, handlerCount: handlers.length, nextCalls }
}

const stringify = (value) => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

test(`契约：apply 注册 ${GATE_EVENT} 处理器（deny 断言的前提）`, () => {
  const host = memberHost(membershipOf('teammate', 'on'))
  apply(host.ctx)
  const handlers = gateHandlers(host)
  assert.ok(
    handlers.length >= 1,
    `apply 未注册 ctx.on('${GATE_EVENT}', handler)；实际监听：[${host.onCalls.map(([event]) => String(event)).join(', ') || '无'}]`,
  )
  for (const [index, handler] of handlers.entries()) {
    assert.equal(typeof handler, 'function', `第 ${index + 1} 个 ${GATE_EVENT} 监听器不是函数`)
  }
})

test('deny 组：teammate + Lead 非 off 时，白名单外工具必须 deny 且不调用 next', async (t) => {
  for (const tool of DENY_TOOLS) {
    await t.test(tool, async () => {
      const host = memberHost(membershipOf('teammate', 'on'))
      apply(host.ctx)
      const { decisions, threw, nextCalls } = await gateOutcome(
        host,
        execOf(tool, agentOf(membershipOf('teammate', 'on'))),
      )
      assert.equal(
        threw,
        undefined,
        `${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`,
      )
      const denied = decisions.filter((decision) => decision?.kind === 'deny')
      assert.ok(denied.length >= 1, `${tool}：成员门禁未 deny（默认拒绝白名单未生效），处理器返回：${stringify(decisions)}`)
      for (const decision of denied) {
        assert.equal(typeof decision.reason, 'string', `${tool}：deny 的 reason 必须是 string，实际 ${typeof decision.reason}（${stringify(decision.reason)}）`)
        assert.match(decision.reason, /(委派|subagent)/, `${tool}：reason 必须说明委派/subagent 要求，实际为「${decision.reason}」`)
      }
      assert.equal(nextCalls, 0, `${tool}：deny 路径不得调用 next（既 deny 又 next = 拦截未生效），实际 next 被调用 ${nextCalls} 次`)
    })
  }
})

test('deny 组：Lead 命令记录 args 的非 off 变体同样 deny（无参数、大写、其它开法）', async (t) => {
  for (const args of [undefined, 'on', 'ON', 'enable', '  on  ']) {
    await t.test(`args=${stringify(args)}`, async () => {
      const membership = membershipOf('teammate', args)
      const host = memberHost(membership)
      apply(host.ctx)
      const { decisions, nextCalls } = await gateOutcome(host, execOf('bash', agentOf(membership)))
      assert.ok(
        decisions.some((decision) => decision?.kind === 'deny'),
        `args=${stringify(args)}：非 off 必须 deny bash，处理器返回：${stringify(decisions)}`,
      )
      assert.equal(nextCalls, 0, `args=${stringify(args)}：deny 路径调用了 next ${nextCalls} 次`)
    })
  }
})

const BOUNDARY_CASES = [
  {
    label: 'B1 Lead 身份（role=lead，Lead 会话已开启）',
    agent: agentOf(membershipOf('lead', 'on')),
    host: () => memberHost(membershipOf('lead', 'on')),
  },
  {
    label: 'B2 teammate 但 Lead 会话 command/run args=off',
    agent: agentOf(membershipOf('teammate', 'off')),
    host: () => memberHost(membershipOf('teammate', 'off')),
  },
  {
    label: 'B3 非成员（tryMembership 返回 undefined）',
    agent: { session: { snapshotEvents: () => [] } },
    host: () => createHost({ agentTeams: { tryMembership: () => undefined } }),
  },
  {
    label: 'B4 agentTeams 服务缺失',
    agent: agentOf(membershipOf('teammate', 'on')),
    host: () => createHost({}),
  },
]

test('边界组：门禁不成立时不得 deny，且 next 恰好一次', async (t) => {
  for (const { label, agent, host: buildHost } of BOUNDARY_CASES) {
    await t.test(label, async () => {
      for (const tool of ['bash', 'run_code', 'mcp__github__get_me']) {
        const host = buildHost()
        apply(host.ctx)
        const { decisions, threw, handlerCount, nextCalls } = await gateOutcome(host, execOf(tool, agent))
        assert.equal(threw, undefined, `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`)
        assert.ok(handlerCount >= 1, `${label} / ${tool}：未注册 ${GATE_EVENT} 处理器，边界断言无意义`)
        for (const [index, decision] of decisions.entries()) {
          assert.notStrictEqual(decision?.kind, 'deny', `${label} / ${tool}：不得 deny，处理器 #${index + 1} 返回 ${stringify(decision)}`)
        }
        assert.equal(nextCalls, 1, `${label} / ${tool}：放行路径必须恰好调用 next 一次，实际 ${nextCalls} 次`)
      }
    })
  }
})
