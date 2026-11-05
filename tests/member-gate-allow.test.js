/**
 * dsh-force-subagent 成员门禁「放行」侧测试（默认拒绝白名单口径）。
 *
 * 契约：apply() 注册 `ctx.on('tools/pre-execute', (exec, next) => ...)`；
 * 成员 = ctx.get('agentTeams').tryMembership(exec.agent) 且 membership.role === 'teammate'；
 * 门禁生效 = membership.root.session 最后一次 command/run(using-agent-team) 事件 args 非 off；
 * 生效时白名单（恰好 21 项，见 ALLOW_TOOLS）内的工具必须放行，放行方式 = 调用 next() 并返回其结果。
 *
 * 放行断言口径（三件套，缺一不可）：
 *   1) 处理器不抛异常；
 *   2) next 恰好被调用一次（nextCalls === 1）；
 *   3) 返回值解析后 kind === 'allow' 且 via === 'next'，即 next() 的结果本身。
 * 旧口径 `decision?.kind !== 'deny'` 已废弃：它放得过 `return undefined`，不构成判据。
 *
 * 变异自证（M1 反例）：把实现的放行分支 `return next()` 改成 `return undefined` 后，
 * 本文件 A 组 21 项与 B 组全部路径都因「期望 nextCalls 1、实际 0」变红；恢复后变绿。
 * 桩验证：复制 index.js 与本文件到 /tmp 独立目录，sed 改放行分支 → node --test → 全部失败；
 * 还原原件 → node --test → 全绿。仓库 index.js 未被改动。
 *
 * 运行：node --test tests/member-gate-allow.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'

const { apply } = plugin

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'

/** 白名单恰好 21 项：teammate 在门禁生效时唯一被允许自己执行的工具。 */
const ALLOW_TOOLS = [
  'subagent',
  'subagent_fork',
  'subagent_role',
  'close_subagent',
  'workflow',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'send_message',
  'wait_agent',
  'list_agents',
  'interrupt_agent',
  'job_output',
  'job_kill',
  'job_list',
  'skill',
  'todo_write',
  'read',
  'grep',
  'glob',
]

/** 真实 ctx 的最小形状：门禁注册发生在 inject 就绪检查之后，systemPrompt / commands 必须齐备。 */
function createHost({ agentTeams } = {}) {
  const onCalls = []
  const warnings = []
  const services = {
    systemPrompt: { section: () => {} },
    commands: { register: () => {} },
    agentTeams,
  }
  const ctx = {
    inject: (deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: ctx.fiber ?? { uid: 'test-fiber' },
      settings: ctx.settings ?? { configure: () => () => {} },
      logger: ctx.logger,
    }),
    logger: { warn: (message) => warnings.push(message) },
    get: (service) => services[service],
    on: (...args) => {
      onCalls.push(args)
    },
  }
  return { ctx, onCalls, warnings }
}

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })

/** teammate 句柄：真实形状由 agentTeams.tryMembership 给出，root.session 是 Lead 会话。 */
const teammateAgent = (leadEvents) => ({
  session: { events: [] },
  membership: { role: 'teammate', root: { session: { events: leadEvents } } },
})

const memberHost = (leadEvents) => createHost({ agentTeams: { tryMembership: (agent) => agent.membership } })

/** 取插件真实登记的门禁处理器；后续调用的是它本身，不是 mock。 */
const gateHandlers = (host) =>
  host.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)

/**
 * 放行判据：调用真实处理器，next 为可计数的 stub，返回值必须解析成 next 的结果。
 * 无处理器时 diagnostic + fail，避免「门禁不存在」被读成「放行通过」。
 */
async function assertAllowed(t, host, tool, agent, label) {
  const handlers = gateHandlers(host)
  if (handlers.length === 0) {
    t.diagnostic(`未注册 ctx.on('${GATE_EVENT}', handler)：${label} / ${tool} 的「放行」无从验证`)
    assert.fail(`${label} / ${tool}：apply 未注册 ${GATE_EVENT} 处理器，门禁缺失`)
  }
  assert.equal(handlers.length, 1, `${label} / ${tool}：应只注册 1 个 ${GATE_EVENT} 处理器，实际 ${handlers.length}`)

  const nextResult = { kind: 'allow', via: 'next' }
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return Promise.resolve(nextResult)
  }

  let returned
  let threw
  try {
    returned = await handlers[0]({ name: tool, tool, agent }, next)
  } catch (error) {
    threw = error
  }

  assert.equal(
    threw,
    undefined,
    `${label} / ${tool}：门禁处理器不得抛异常，实际抛出：${threw instanceof Error ? threw.message : String(threw)}`,
  )
  assert.equal(nextCalls, 1, `${label} / ${tool}：放行必须恰好调用一次 next，实际 nextCalls = ${nextCalls}`)

  const resolved = await returned
  assert.equal(
    resolved?.kind,
    'allow',
    `${label} / ${tool}：返回值必须是 next() 的结果（kind === 'allow'），实际 ${String(JSON.stringify(resolved))}；return undefined 不算放行`,
  )
  assert.equal(resolved?.via, 'next', `${label} / ${tool}：返回值必须来自 next()（via === 'next'），实际 ${String(JSON.stringify(resolved))}`)
}

test(`契约：apply 注册 ${GATE_EVENT} 处理器且为函数`, (t) => {
  const host = memberHost([runEvent('on')])
  apply(host.ctx)
  const handlers = gateHandlers(host)
  if (handlers.length === 0) {
    t.diagnostic(`apply 未注册 ctx.on('${GATE_EVENT}', handler)；实际监听：[${host.onCalls.map(([event]) => String(event)).join(', ') || '无'}]`)
  }
  assert.ok(
    handlers.length >= 1,
    `apply 未注册 ctx.on('${GATE_EVENT}', handler)；实际监听：[${host.onCalls.map(([event]) => String(event)).join(', ') || '无'}]`,
  )
  for (const [index, handler] of handlers.entries()) {
    assert.equal(typeof handler, 'function', `第 ${index + 1} 个 ${GATE_EVENT} 监听器不是函数，而是 ${typeof handler}`)
  }
})

test('白名单表自检：恰好 21 项且无重复', () => {
  assert.equal(ALLOW_TOOLS.length, 21, `ALLOW_TOOLS 必须恰好 21 项，实际 ${ALLOW_TOOLS.length}`)
  assert.equal(new Set(ALLOW_TOOLS).size, 21, `ALLOW_TOOLS 存在重复项：${ALLOW_TOOLS.filter((tool, index) => ALLOW_TOOLS.indexOf(tool) !== index).join(', ')}`)
})

test('A 组：teammate + Lead 非 off 时，白名单 21 项必须经 next() 放行', async (t) => {
  for (const tool of ALLOW_TOOLS) {
    await t.test(tool, async () => {
      const host = memberHost([runEvent('on')])
      apply(host.ctx)
      await assertAllowed(t, host, tool, teammateAgent([runEvent('on')]), 'teammate + lead on')
    })
  }
})

const ALLOW_PATHS = [
  {
    label: 'B1 未命中成员：tryMembership 返回 undefined',
    host: () => createHost({ agentTeams: { tryMembership: () => undefined } }),
    agent: () => ({ session: { events: [runEvent('on')] } }),
  },
  {
    label: "B2 agentTeams 服务缺失：ctx.get('agentTeams') 返回 undefined",
    host: () => createHost(),
    agent: () => ({ session: { events: [runEvent('on')] } }),
  },
  {
    label: 'B3 Lead 会话最后一次 command/run 为 off',
    host: () => memberHost([runEvent('off')]),
    agent: () => teammateAgent([runEvent('off')]),
  },
  {
    label: 'B4a tryMembership 抛异常：处理器不得外抛，必须仍走 next',
    host: () => createHost({ agentTeams: { tryMembership: () => { throw new Error('membership exploded') } } }),
    agent: () => ({ session: { events: [] } }),
  },
  {
    label: 'B4b Lead 会话 snapshotEvents 抛异常：处理器不得外抛，必须仍走 next',
    host: () => createHost({ agentTeams: { tryMembership: (agent) => agent.membership } }),
    agent: () => ({
      session: { events: [] },
      membership: { role: 'teammate', root: { session: { snapshotEvents: () => { throw new Error('lead snapshot exploded') } } } },
    }),
  },
]

/** 门禁未生效/评估失败的路径必须整工具放行（含白名单外的 bash），证明门禁在 allowlist 判定前就短路。 */
const PROBE_TOOLS = ['read', 'subagent', 'send_message', 'bash', 'edit', 'mcp__github__get_me']

test('B 组：门禁不生效或评估失败时必须经 next() 放行', async (t) => {
  for (const { label, host: buildHost, agent: buildAgent } of ALLOW_PATHS) {
    await t.test(label, async (inner) => {
      for (const tool of PROBE_TOOLS) {
        await inner.test(tool, async () => {
          const host = buildHost()
          apply(host.ctx)
          await assertAllowed(inner, host, tool, buildAgent(), label)
        })
      }
    })
  }
})
