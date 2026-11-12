/**
 * rc.2 形状宿主下的成员身份与门禁测试。
 *
 * 为什么单独一份：rc.2 删掉了 `agentTeams.tryMembership`，也不再往会话追加 `team/member` 事件，
 * 只剩 `team/mode` 与 `team/task`；成员身份只能由委派树派生（`subagents.rootOf` + 会话头 delegationDepth）。
 * 这里用的是 rc.2 形状的宿主（有 agentTeams 服务但没有 tryMembership、有 subagents 服务、
 * 没有 maxMembers 这类配置），验证插件在这台宿主上的实际行为，而不只是单元层面的取值。
 *
 * 运行：node --test tests/rc2-membership.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, resolveMembership, finishedMembers } from '../index.js'

const GATE_EVENT = 'tools/pre-execute'
const COMMAND_NAME = 'using-agent-team'
const ROOT_ID = 'session-lead'
const MEMBER_ID = 'session-worker'
const NESTED_ID = 'session-worker-child'

const runEvent = (args) => ({ type: 'command/run', data: { name: COMMAND_NAME, args } })
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const toolCall = (name, callId = `call-${name}`) => ({ type: 'tool/call', data: { name, callId } })
const taskEvent = (id, status, revision = 1, ownerId) => ({
  type: 'team/task',
  data: {
    version: 2,
    teamId: 'team-1',
    task: { id, subject: `task ${id}`, status, revision, blockedBy: [], ...(ownerId === undefined ? {} : { ownerId }) },
  },
})

/** 带 notice 投递通道的会话 Agent；header.delegationDepth 是 rc.2 判定委派深度的依据。 */
function agentOf({ id = ROOT_ID, name, depth = 0, events = [runEvent('on')] } = {}) {
  return {
    id,
    ...(name === undefined ? {} : { name }),
    session: { events, header: { delegationDepth: depth } },
    notices: [],
    inject(message) {
      this.notices.push(message)
    },
  }
}

/**
 * rc.2 形状宿主：agentTeams 服务在但没有 tryMembership，subagents 服务提供 rootOf / resolveName / volatile 容量字段，
 * settings 记录每一次写入用于「不得写 agent-team 命名空间」的断言。
 */
function createHost({ subagents, agentTeams = { isEnabled: () => true }, mode } = {}) {
  const settingsWrites = []
  const ctx = {
    logger: { warn: (message) => { ctx.warnings.push(message) } },
    warnings: [],
    get: (service) => (
      service === 'systemPrompt' ? { section: () => () => {} }
        : service === 'commands' ? { register: () => () => {} }
          : service === 'agentTeams' ? agentTeams
            : service === 'subagents' ? subagents
              : service === 'settings' ? settings
                : undefined
    ),
    on: (...args) => { ctx.onCalls.push(args) },
    onCalls: [],
    effect: (factory) => factory(),
    fiber: { uid: 'test-fiber' },
    inject: (_deps, callback) => callback({
      effect: (factory) => factory(),
      fiber: { uid: 'test-fiber' },
      settings,
      logger: ctx.logger,
    }),
  }
  const settings = {
    configure: () => () => {},
    describe: () => [{ ns: 'subagent', revision: 1, value: { maxActiveSubagents: 1024, maxDepth: 2 } }],
    update: async (ns, patch) => {
      settingsWrites.push({ ns, patch })
      return true
    },
  }
  apply(ctx, mode === undefined ? {} : { mode })
  return { ctx, settingsWrites, warnings: ctx.warnings }
}

/** rc.2 的 subagents 服务形状：rootOf 返回委派树根，resolveName 把模型侧名字解析成 Session id。 */
function rc2Subagents({ names = new Map([[ 'worker-1', MEMBER_ID ]]), rootOfCalls = { count: 0 }, throwRootOf } = {}) {
  const root = { id: ROOT_ID, session: { events: [runEvent('on')], header: { delegationDepth: 0 } } }
  return {
    root: () => root,
    rootOf(agent) {
      rootOfCalls.count += 1
      if (throwRootOf !== undefined) throw new Error(throwRootOf)
      return agent.id === ROOT_ID ? agent : root
    },
    resolveName: async (_caller, name) => {
      const id = names.get(name)
      if (id === undefined) throw new Error(`AGENT_NAME_NOT_FOUND: ${name}`)
      return id
    },
    config: {
      maxActiveSubagents: { get: () => 1024 },
      maxDepth: { get: () => 2 },
    },
    startActivation: () => () => {},
  }
}

const gateHandlers = (host) => host.ctx.onCalls.filter(([event]) => event === GATE_EVENT).map(([, handler]) => handler)

const execOf = (name, agent, args = {}) => ({
  callId: `call-${name}`,
  name,
  arguments: args,
  agent,
  signal: new AbortController().signal,
})

async function gateOutcome(host, exec) {
  let nextCalls = 0
  const decisions = []
  for (const handler of gateHandlers(host)) decisions.push(await handler(exec, () => { nextCalls += 1 }))
  return { decisions, nextCalls, notices: exec.agent.notices, warnings: host.warnings }
}

/** 提醒走 agent.inject 的消息对象；断言统一取其中的文本。 */
const noticeText = (notice) => (typeof notice === 'string' ? notice : notice?.content?.[0]?.text ?? String(notice))

/** 软门禁的固定判据：工具真的执行（next 一次），且没有任何拒绝决策。 */
function assertSoftGate(outcome) {
  assert.equal(outcome.nextCalls, 1, '软门禁必须放行工具调用（next 恰好一次）')
  assert.deepEqual(outcome.decisions.filter((decision) => decision?.kind === 'deny'), [], '门禁不得拒绝工具调用')
}

/* ────────────────────────── 身份推导 ────────────────────────── */

test('rc.2 宿主（无 tryMembership）：成员身份由 rootOf + delegationDepth 推导，Lead / 成员 / 更深层各归各位', () => {
  const subagents = rc2Subagents()
  const host = createHost({ subagents })
  const lead = agentOf({ id: ROOT_ID, depth: 0 })
  const member = agentOf({ id: MEMBER_ID, name: 'worker-1', depth: 1 })
  const nested = agentOf({ id: NESTED_ID, name: 'worker-1-sub', depth: 2 })

  const leadMembership = resolveMembership(host.ctx, lead)
  assert.equal(leadMembership.role, 'lead', 'rootOf 返回自己 = Lead')
  assert.equal(leadMembership.root.id, ROOT_ID)

  const memberMembership = resolveMembership(host.ctx, member)
  assert.equal(memberMembership.role, 'teammate', 'delegationDepth 1 的后代 = 成员')
  assert.equal(memberMembership.root.id, ROOT_ID, '成员的 root 必须是 Lead 会话，开关判定才能落到 Lead 上')
  assert.equal(memberMembership.name, 'worker-1')

  assert.equal(resolveMembership(host.ctx, nested), undefined, '深度 ≥ 2 不是团队成员：既不按 Lead 也不按成员门禁')
  assert.equal(host.warnings.length, 0, `身份判定正常时不该 warn：${host.warnings.join(' | ')}`)
})

test('rc.2 宿主：判不出深度（会话头没有 delegationDepth）就不认定成员身份，也不 warn', () => {
  const host = createHost({ subagents: rc2Subagents() })
  const headless = { id: MEMBER_ID, name: 'worker-1', session: { events: [runEvent('on')] }, notices: [], inject(m) { this.notices.push(m) } }
  assert.equal(resolveMembership(host.ctx, headless), undefined, '深度未知时不猜身份，工具按「非成员」路径处理')
  assert.equal(host.warnings.length, 0)
})

test('rc.1 兼容：agentTeams.tryMembership 存在时优先采用它的结论，不碰 rootOf', () => {
  const rootOfCalls = { count: 0 }
  const rc1Membership = { role: 'teammate', id: 'legacy-1', name: 'legacy', root: { session: { events: [runEvent('on')] } } }
  const host = createHost({
    agentTeams: { tryMembership: (agent) => (agent.id === MEMBER_ID ? rc1Membership : undefined) },
    subagents: rc2Subagents({ rootOfCalls }),
  })
  const found = resolveMembership(host.ctx, agentOf({ id: MEMBER_ID, depth: 1 }))
  assert.equal(found, rc1Membership, 'rc.1 的判定结果必须原样使用')
  assert.equal(rootOfCalls.count, 0, '有 tryMembership 就不该走 rc.2 推导')
})

test('身份不可用：既无 tryMembership 也无 rootOf 时如实 warn 一次，工具照常放行', async () => {
  const host = createHost({ subagents: undefined })
  const lead = agentOf({ id: ROOT_ID, depth: 0 })
  assert.equal(resolveMembership(host.ctx, lead), undefined)
  assert.equal(host.warnings.length, 0, '直接查询身份不该 warn')

  const outcome = await gateOutcome(host, execOf('bash', lead, { command: 'ls' }))
  assertSoftGate(outcome)
  assert.equal(outcome.notices.length, 0, '身份不可用时不投递提醒')
  assert.equal(host.warnings.length, 1, `只许 warn 一次：${host.warnings.join(' | ')}`)
  assert.match(host.warnings[0], /agentTeams/, 'warn 必须点名缺失的服务')
  assert.equal(host.warnings.length, 1, '门禁复用同一份缺失事实，不重复 warn')
})

test('rc2Subagents.rootOf 抛错：fail-open 放行并 warn 一次，不把宿主卡死', async () => {
  const host = createHost({ subagents: rc2Subagents({ throwRootOf: 'session store closed' }) })
  const lead = agentOf({ id: ROOT_ID, depth: 0 })
  const outcome = await gateOutcome(host, execOf('bash', lead, { command: 'ls' }))
  assertSoftGate(outcome)
  assert.equal(host.warnings.length, 1, `只许 warn 一次：${host.warnings.join(' | ')}`)
  assert.match(host.warnings[0], /rootOf/, `warn 必须点名失败原因：${host.warnings[0]}`)
})

/* ────────────────────────── 门禁在 rc.2 形状宿主上的实际行为 ────────────────────────── */

test('rc.2 Lead 取证门禁：本轮没有委派就提醒一次 Lead 去派成员，工具照常执行', async () => {
  const host = createHost({ subagents: rc2Subagents() })
  const lead = agentOf({ id: ROOT_ID, depth: 0, events: [runEvent('on'), turnStart(1)] })
  const first = await gateOutcome(host, execOf('bash', lead, { command: 'ls' }))
  assertSoftGate(first)
  assert.equal(first.notices.length, 1, '本轮首次动取证工具必须提醒一次')
  assert.match(noticeText(first.notices[0]), /^\[team-gate\]/, '提醒必须带门禁前缀')
  assert.match(noticeText(first.notices[0]), /subagent/, '出路必须点名 rc.2 的委派工具')

  const second = await gateOutcome(host, execOf('read', lead, { file_path: 'a.ts' }))
  assertSoftGate(second)
  assert.equal(second.notices.length, 1, '同一轮内不重复提醒')
})

test('rc.2 Lead 派出的取证 subagent（深度 1 的非成员路径由成员门禁负责）：深度 ≥ 2 完全不进 Lead 门禁', async () => {
  const host = createHost({ subagents: rc2Subagents() })
  const grandchild = agentOf({ id: NESTED_ID, name: 'worker-1-sub', depth: 2, events: [runEvent('on'), turnStart(1)] })
  const outcome = await gateOutcome(host, execOf('bash', grandchild, { command: 'ls' }))
  assertSoftGate(outcome)
  assert.equal(outcome.notices.length, 0, '更深层的后代既不是 Lead 也不是成员，不该被门禁打扰')
})

test('rc.2 成员（深度 1）nested：非白名单工具提醒，白名单工具静默放行', async () => {
  const host = createHost({ subagents: rc2Subagents(), mode: 'nested' })
  const member = agentOf({ id: MEMBER_ID, name: 'worker-1', depth: 1, events: [runEvent('on'), turnStart(1)] })
  const blocked = await gateOutcome(host, execOf('write', member, { file_path: 'a.ts', content: 'x' }))
  assertSoftGate(blocked)
  assert.equal(blocked.notices.length, 1)
  assert.match(noticeText(blocked.notices[0]), /^\[team-gate\]/)

  const reader = agentOf({ id: 'session-reader', name: 'worker-read', depth: 1, events: [runEvent('on'), turnStart(1)] })
  const allowed = await gateOutcome(host, execOf('read', reader, { file_path: 'a.ts' }))
  assertSoftGate(allowed)
  assert.equal(allowed.notices.length, 0, '白名单里的只读工具不该收到提醒')
})

test('rc.2 flat 成员：委派类工具被提醒，成员自己的实现工具静默放行', async () => {
  const host = createHost({ subagents: rc2Subagents(), mode: 'flat' })
  const member = agentOf({ id: MEMBER_ID, name: 'worker-1', depth: 1, events: [runEvent('on'), turnStart(1)] })
  const delegated = await gateOutcome(host, execOf('subagent', member, { description: 'x', prompt: 'y' }))
  assertSoftGate(delegated)
  assert.equal(delegated.notices.length, 1, 'flat 下成员派子代理必须收到提醒')
  assert.match(noticeText(delegated.notices[0]), /flat/, '提醒必须说明当前是 flat 模式')

  const ownWork = await gateOutcome(host, execOf('bash', agentOf({ id: 'session-own', name: 'worker-own', depth: 1, events: [runEvent('on'), turnStart(1)] }), { command: 'ls' }))
  assertSoftGate(ownWork)
  assert.equal(ownWork.notices.length, 0, 'flat 下成员自己执行不受门禁约束')
})

/* ────────────────────────── 已完成成员判定（rc.2 只认 team/task 的 ownerId） ────────────────────────── */

test('finishedMembers：rc.2 无 team/member 事件，仅凭 team/task 的 ownerId 判定已完成成员', () => {
  const events = [
    taskEvent('t1', 'pending', 1, MEMBER_ID),
    taskEvent('t1', 'in_progress', 2, MEMBER_ID),
    taskEvent('t1', 'completed', 3, MEMBER_ID),
    taskEvent('t2', 'completed', 1, ROOT_ID),
    taskEvent('t3', 'in_progress', 1, 'session-other'),
  ]
  const { finished, idsByName } = finishedMembers(events, ROOT_ID)
  assert.equal(finished.has(MEMBER_ID), true, '名下任务全完成的成员必须判为已完成')
  assert.equal(finished.has(ROOT_ID), false, 'Lead 自己名下任务完成不算已完成成员')
  assert.equal(finished.has('session-other'), false, '名下任务仍在进行中的 owner 不是已完成成员')
  assert.equal(idsByName.size, 0, 'rc.2 不再有 team/member 事件，名字表为空')
})

test('finishedMembers：名下还有未完成任务的成员不得判为已完成', () => {
  const events = [
    taskEvent('t1', 'completed', 1, MEMBER_ID),
    taskEvent('t2', 'in_progress', 1, MEMBER_ID),
  ]
  const { finished } = finishedMembers(events, ROOT_ID)
  assert.equal(finished.has(MEMBER_ID), false)
})

test('rc.2 已完成成员门禁：send_message 用 agent_id 寻址已完成成员时投递 TEAM_MEMBER_FINISHED 提醒', async () => {
  const events = [runEvent('on'), turnStart(1), taskEvent('t1', 'completed', 1, MEMBER_ID)]
  const host = createHost({ subagents: rc2Subagents() })
  const lead = agentOf({ id: ROOT_ID, depth: 0, events })
  const outcome = await gateOutcome(host, execOf('send_message', lead, { agent_id: MEMBER_ID, message: '再改一轮' }))
  assertSoftGate(outcome)
  assert.equal(outcome.notices.length, 1, '向已完成成员发消息必须提醒一次')
  assert.match(noticeText(outcome.notices[0]), /\[team-gate\] TEAM_MEMBER_FINISHED:/, '提醒前缀必须保持不变')
  assert.match(noticeText(outcome.notices[0]), /subagent/, '出路必须点名 rc.2 的新成员派发方式')
  assert.doesNotMatch(noticeText(outcome.notices[0]), /spawn_teammate|close_subagent/, '提醒文案不得再出现 rc.2 不存在的工具名')
})

test('rc.2 已完成成员门禁：reassign 的 owner 名字经宿主 resolveName 解析后同样命中', async () => {
  const events = [runEvent('on'), turnStart(1), taskEvent('t1', 'completed', 1, MEMBER_ID)]
  const host = createHost({ subagents: rc2Subagents() })
  const lead = agentOf({ id: ROOT_ID, depth: 0, events })
  const outcome = await gateOutcome(host, execOf('team_task_update', lead, { action: 'reassign', task_id: 't2', owner: 'worker-1' }))
  assertSoftGate(outcome)
  assert.equal(outcome.notices.length, 1, '把任务 reassign 给已完成成员必须提醒')
  assert.match(noticeText(outcome.notices[0]), /TEAM_MEMBER_FINISHED:/)
})

test('已完成成员门禁：resolveName 解析不到名字时按「判不了就不提醒」放行且不 warn', async () => {
  const events = [runEvent('on'), turnStart(1), taskEvent('t1', 'completed', 1, MEMBER_ID)]
  const host = createHost({ subagents: rc2Subagents({ names: new Map() }) })
  const lead = agentOf({ id: ROOT_ID, depth: 0, events })
  const outcome = await gateOutcome(host, execOf('team_task_update', lead, { action: 'reassign', task_id: 't2', owner: 'ghost' }))
  assertSoftGate(outcome)
  assert.equal(outcome.notices.length, 0, '名字解析不到就不是判定对象')
  assert.equal(outcome.warnings.length, 0, `解析失败不该 warn：${outcome.warnings.join(' | ')}`)
})

/* ────────────────────────── 不往任何地方写成员上限 ────────────────────────── */

test('rc.2 宿主里没有 maxMembers：整条门禁链路不产生任何 settings 写入', async () => {
  const host = createHost({ subagents: rc2Subagents(), mode: 'flat' })
  const lead = agentOf({ id: ROOT_ID, depth: 0, events: [runEvent('on'), turnStart(1)] })
  const member = agentOf({ id: MEMBER_ID, name: 'worker-1', depth: 1, events: [runEvent('on'), turnStart(1)] })
  await gateOutcome(host, execOf('bash', lead, { command: 'ls' }))
  await gateOutcome(host, execOf('subagent', member, { description: 'x', prompt: 'y' }))
  await gateOutcome(host, execOf('send_message', lead, { agent_id: MEMBER_ID, message: '继续' }))
  assert.equal(host.settingsWrites.length, 0, `门禁只读不写：观察到 ${host.settingsWrites.length} 次写入`)
  assert.deepEqual(host.settingsWrites, [])
})

test('rc.2 宿主里 agent-team 命名空间不存在：插件也不去写它', () => {
  const host = createHost({ subagents: rc2Subagents() })
  assert.ok(gateHandlers(host).length >= 1, 'apply 必须注册门禁监听器')
  assert.equal(host.settingsWrites.length, 0, 'apply 阶段不得写任何命名空间')
  assert.deepEqual(
    host.ctx.onCalls.map(([event]) => event).filter((event) => event === 'settings/document-updated'),
    [],
    '插件不再桥接 settings 文档变更去改写成员上限',
  )
})
