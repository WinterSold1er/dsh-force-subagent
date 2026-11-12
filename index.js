/**
 * dsh-force-subagent — 用 /using-agent-team 命令按会话启用 Agent-Team 强制委派提示。
 *
 * 状态不落盘：门控直接派生自宿主已记录的 `command/run` 事件
 * （packages/interaction/commands/src/index.ts:373-378 写入 session 事件日志），
 * 在 systemPrompt.section 的 text(context) 里按会话读取即可，天然隔离、幂等。
 * 成员会话没有自己的 command/run 记录：rc.2 经 ctx.subagents.rootOf 回溯团队 root（Lead）会话开关；
 * 宿主仍暴露 agentTeams.tryMembership 时（rc.1）沿用该判定，行为不变。
 * 命令 handler 返回会话页可见的一行结果，同时投递一条模型可见的 user notice：
 * 带 task 走 agent.steer（空闲起一轮、运行中下一步送达），其余走 agent.inject（不唤醒）。
 * task 随 `command/run` 事件持久在 section 里，直到 `off`。不写任何自定义状态。
 * tools/pre-execute：成员侧、flat 模式成员侧与 Lead 侧一律是软门禁（放行 + 投递一次模型可见提醒，复用 agent.inject 通道）；
 * 插件在任何判据下都不返回拒绝结果。Lead 侧判据只看「本轮（事件里最后一个 turn/start 之后）有没有委派类派发」：
 * 没有派发就动取证 / 实现 / 执行工具 → 投递一条提醒并照常放行；去重按轮次刷新，Lead 收到新消息（新的 turn/start）后再动这些工具会重新提醒一次。
 */

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

export const name = 'force-subagent'

export const inject = ['commands', 'systemPrompt', 'subagents']

/** 默认路由（可被 Config 覆盖）：子代理默认继承 parent 路由（manager.resolveChildAgentOptions），未配置时本地 in-process 子代理落到 DEFAULT_ROUTE。 */
/** 默认路由：未配置时与历史硬编码一致，行为不变。 */
export const DEFAULT_ROUTE = { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }
/** 兼容旧导出名。 */
export const TEAM_MEMBER_ROUTE = DEFAULT_ROUTE
/** 未配置时的完整默认值。 */
export const DEFAULT_CONFIG = { enabled: true, mode: 'nested', member: { ...DEFAULT_ROUTE }, subagent: { ...DEFAULT_ROUTE }, workspaces: {} }

const routeSchema = () => Schema.object({
  provider: Schema.string().default(DEFAULT_ROUTE.provider),
  model: Schema.string().default(DEFAULT_ROUTE.model),
})

const workspaceSchema = () => Schema.object({
  member: routeSchema().default({ ...DEFAULT_ROUTE }),
  subagent: routeSchema().default({ ...DEFAULT_ROUTE }),
})

/**
 * rc.2 起「同时活着的成员数」归 subagent 服务管：profile 条目 `subagent` 的 volatile Config.maxActiveSubagents，
 * 嵌套深度由同一 Config.maxDepth 决定。插件不再写任何 patch 文件，改走 settings 服务写那个命名空间
 * （宿主负责持久化与即时生效）。这里只保留输入护栏。
 */
/** 护栏：一个成员是一个完整 agent 会话，超过这个数量就是误输入。宿主 zod 只有 min(1)，本身没有上限。 */
export const MAX_CAPACITY_LIMIT = 100_000
/** rc.1 之前宿主 bundle 的成员默认值，只用于文案说明，不再写回任何配置层。 */
export const LEGACY_TEAM_MEMBER_DEFAULT = 16

/**
 * Cordis Config：根 volatile，settings 服务据此暴露可写命名空间（namespace = entry id）。
 * 成员容量与嵌套深度不在本命名空间：面板直接读写 `subagent` 命名空间（见 CAPACITY_NS）。
 * 根 .volatile() 级联让各子路径都可经 configForms 读写（宿主 isVolatilePath：schema.meta.volatile → true）。
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  member: routeSchema().default({ ...DEFAULT_ROUTE }),
  subagent: routeSchema().default({ ...DEFAULT_ROUTE }),
  mode: Schema.string().default('nested'),
  workspaces: Schema.dict(workspaceSchema()).default({}),
}).volatile()

/** 根 volatile 的 Config 会被 Cordis 解析成 Volatile 引用（有 .get()）：读值前统一解包。 */
function unwrapVolatile(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/** mode 取值非法只警告一次：mode 在每次实时配置解析里都会归一化，逐次 warn 会刷屏。 */
let warnedMode = false

/** mode 归一化：只有字符串 'flat' / 'nested' 是有效取值；缺失、null、空串沿用 fallback；其它取值（拼错、非字符串）warn 一次后回退 'nested'。 */
function normalizeMode(value, fallback, warn) {
  if (value === 'flat' || value === 'nested') return value
  if (value === undefined || value === null || value === '') return fallback
  if (!warnedMode) {
    warnedMode = true
    warn?.(`配置 mode 取值非法（${typeof value === 'string' ? JSON.stringify(value) : typeof value}），已回退 'nested'。`)
  }
  return 'nested'
}

/** 配置深合并：缺省/非法值回退默认，workspaces 逐项规范化，永不抛。warn 可选，只用于 mode 非法取值（warn-once）。 */
export function resolveConfig(config, warn) {
  const source = unwrapVolatile(config)
  const root = source !== null && typeof source === 'object' ? source : {}
  const mode = normalizeMode(root.mode, DEFAULT_CONFIG.mode, warn)
  const route = (value, fallback) => {
    const candidate = unwrapVolatile(value)
    const fields = candidate !== null && typeof candidate === 'object' ? candidate : {}
    return {
      provider: typeof fields.provider === 'string' && fields.provider.length > 0 ? fields.provider : fallback.provider,
      model: typeof fields.model === 'string' && fields.model.length > 0 ? fields.model : fallback.model,
    }
  }
  const workspaces = {}
  const rawWorkspaces = unwrapVolatile(root.workspaces)
  if (rawWorkspaces !== null && typeof rawWorkspaces === 'object' && !Array.isArray(rawWorkspaces)) {
    for (const [key, entry] of Object.entries(rawWorkspaces)) {
      if (typeof key !== 'string' || key.length === 0) continue
      const item = unwrapVolatile(entry)
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      workspaces[key] = {
        member: route(item.member, DEFAULT_CONFIG.member),
        subagent: route(item.subagent, DEFAULT_CONFIG.subagent),
      }
    }
  }
  return {
    enabled: typeof root.enabled === 'boolean' ? root.enabled : DEFAULT_CONFIG.enabled,
    mode,
    member: route(root.member, DEFAULT_CONFIG.member),
    subagent: route(root.subagent, DEFAULT_CONFIG.subagent),
    workspaces,
  }
}

/** 沿 parentSession 上溯的最大层数（防环由 seen 集合额外保证）。 */
const WORKSPACE_TRACE_LIMIT = 8
/** workspaceRegistry 反查失败只警告一次（headless 组合可能根本没有该服务）。 */
let warnedWorkspaceRegistry = false

/** workspaceKey 语义：优先绝对路径，注册 id 仅作兜底；页面与宿主必须同一取值。 */
export function workspaceKey(workspace) {
  if (workspace === undefined || workspace === null) return undefined
  if (typeof workspace.path === 'string' && workspace.path.length > 0) return workspace.path
  if (workspace.id !== undefined && workspace.id !== null) return String(workspace.id)
  return undefined
}

/** 该 workspace 列表项的 sessionIds 是否包含给定 id。 */
function workspaceHasSession(workspace, id) {
  const sessionIds = workspace?.sessionIds
  return Array.isArray(sessionIds) && sessionIds.includes(id)
}

/** session.cwd 优先，宿主 Session 另暴露 header.cwd。 */
function sessionCwd(session) {
  if (typeof session?.cwd === 'string' && session.cwd.length > 0) return session.cwd
  const headerCwd = session?.header?.cwd
  return typeof headerCwd === 'string' && headerCwd.length > 0 ? headerCwd : undefined
}

/**
 * 解析会话所属工作区的 key：
 * 1) session.id ∈ workspace.sessionIds；
 * 2) 否则沿 session.header.parentSession 上溯（≤8 层，seen 防环）；
 * 3) 否则 session.cwd === workspace.path；
 * 4) 否则用 session.cwd 本身（未注册目录按目录隔离）；
 * 5) 拿不到 session/cwd → undefined（回退全局默认）。
 * workspaceRegistry 缺失或反查抛错一律 fail-open，只 warn 一次。
 */
export function workspaceKeyFor(ctx, session) {
  if (session === undefined || session === null) return undefined
  let registry
  try {
    registry = ctx?.get?.('workspaceRegistry')
  } catch (error) {
    if (!warnedWorkspaceRegistry) {
      warnedWorkspaceRegistry = true
      ctx?.logger?.warn?.(`[force-subagent] 读取 workspaceRegistry 失败，工作区路由回退全局默认：${error instanceof Error ? error.message : String(error)}`)
    }
    registry = undefined
  }
  let workspaces = []
  if (registry !== undefined && registry !== null) {
    try {
      const listed = typeof registry.list === 'function' ? registry.list() : undefined
      if (Array.isArray(listed)) workspaces = listed
    } catch (error) {
      if (!warnedWorkspaceRegistry) {
        warnedWorkspaceRegistry = true
        ctx?.logger?.warn?.(`[force-subagent] workspaceRegistry.list 失败，工作区路由回退全局默认：${error instanceof Error ? error.message : String(error)}`)
      }
      return undefined
    }
  }
  const seen = new Set()
  let cursor = session
  for (let depth = 0; depth <= WORKSPACE_TRACE_LIMIT && cursor !== undefined && cursor !== null; depth += 1) {
    const id = cursor.id
    if (typeof id === 'string' && id.length > 0) {
      if (seen.has(id)) break
      seen.add(id)
      const hit = workspaces.find((workspace) => workspaceHasSession(workspace, id))
      if (hit !== undefined) return workspaceKey(hit)
    }
    const parentId = cursor?.header?.parentSession
    if (typeof parentId !== 'string' || parentId.length === 0) break
    // 先用父会话 id 比对登记表：父会话对象未加载时也能命中，不必依赖 sessions.get。
    const parentHit = workspaces.find((workspace) => workspaceHasSession(workspace, parentId))
    if (parentHit !== undefined) return workspaceKey(parentHit)
    cursor = ctx?.get?.('sessions')?.get?.(parentId)
  }
  const cwd = sessionCwd(session)
  if (cwd === undefined) return undefined
  const byPath = workspaces.find((workspace) => typeof workspace?.path === 'string' && workspace.path === cwd)
  if (byPath !== undefined) return workspaceKey(byPath)
  return cwd
}

/** 路由解析：工作区覆盖优先，否则回退全局同类路由。 */
export function resolveRoute(settings, key, kind) {
  if (settings === undefined || settings === null) return undefined
  const scoped = key !== undefined && settings.workspaces !== undefined ? settings.workspaces[key] : undefined
  if (scoped !== undefined && scoped !== null && scoped[kind] !== undefined) return scoped[kind]
  return settings[kind]
}

/** 宿主 Session 的 id：Session.id 与 SessionHeader.id 同源（core/session/src/types.ts:95 起）。 */
function sessionIdOf(session) {
  const direct = session?.id
  if (typeof direct === 'string' && direct.length > 0) return direct
  const headerId = session?.header?.id
  return typeof headerId === 'string' && headerId.length > 0 ? headerId : undefined
}

/**
 * 读取会话「当前模型选择」，口径与宿主自身判定所用模型完全一致：
 * modelSelection 投影的 wire 视图是 `{ lastUsed, next }`，`next = pending ?? lastUsed`
 * （packages/core/agent/src/model-selection.ts:86-89），与宿主 AgentModel.recordedSelection 的
 * `pending ?? lastUsed`（同文件 :117-120）等价；只比 provider + model，与宿主 sameRoute 同一判据
 * （同文件 :42-44）——reasoningEffort 本来就被注入逻辑删掉，不参与比较。
 * 读通道用宿主公开的投影读面 `ctx.sessionProjections.snapshot(session)`（生产先例：
 * packages/api/session-controller/src/control.ts:67；该单元由 core/agent-loop/src/index.ts:334 注册）。
 * @returns {provider, model}，或 undefined（服务缺失 / 该单元未注册 / provider|model 不成对
 *   —— 判定不了就不比较，也不 warn）；ctx.get 或 snapshot 抛错时把 error 交给 onFailure，由调用方 warn 一次。
 */
export function sessionModelSelection(ctx, session, onFailure) {
  if (session === undefined || session === null) return undefined
  const report = (error) => {
    if (typeof onFailure === 'function') onFailure(error)
  }
  let projections
  try {
    projections = ctx?.get?.('sessionProjections')
  } catch (error) {
    report(error)
    return undefined
  }
  if (projections === undefined || projections === null || typeof projections.snapshot !== 'function') return undefined
  let snapshot
  try {
    snapshot = projections.snapshot(session)
  } catch (error) {
    report(error)
    return undefined
  }
  const view = snapshot?.values?.modelSelection
  const selection = view?.next ?? view?.lastUsed
  const provider = selection?.provider
  const model = selection?.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/** 会话里已登记的 Team 成员 childId 集合（agent-team 在 startActivation 前写 team/member 事件，member.id === childId）。 */
/** 读取失败的会话：同一 session 只告警一次，避免每次激活都刷屏。 */
const memberReadFailures = new WeakSet()

export function memberIds(sessionLike, onFailure) {
  const ids = new Set()
  try {
    const events = readEvents(sessionLike)
    if (!Array.isArray(events)) return ids
    for (const event of events) {
      const id = event?.type === 'team/member' ? event?.data?.member?.id : undefined
      if (typeof id === 'string') ids.add(id)
    }
  } catch (error) {
    if (typeof onFailure === 'function') {
      const key = sessionLike !== null && typeof sessionLike === 'object' ? sessionLike : undefined
      if (key === undefined || !memberReadFailures.has(key)) {
        if (key !== undefined) memberReadFailures.add(key)
        onFailure(error)
      }
    }
    return new Set()
  }
  return ids
}

/**
 * 「已完成成员」判定。宿主 team/task 事件是整值快照（task-board.ts:208 每次变更 appendAndFlush 一条），
 * 同一 task 会有多条快照，所以「当前状态」按 task.id 只认最后一条；「曾完成过」扫全部快照。
 * finished(m) = 曾完成过(m) AND 当前无在办(m)：
 * - 曾完成过：任一条快照 `ownerId === m && status ∈ {completed, deleted}`，永久置位、不清除。
 *   reopen 会清 owner（task-board.ts:170 withoutOwner），若不记历史，Lead 就能「reopen → 旧成员自 claim」绕过门禁。
 * - 当前无在办：最后快照里不存在 `ownerId === m && status ∈ {pending, in_progress}`。
 * 只认在 team/member 事件里登记过的成员：Lead 不在其中（宿主 projection.ts:344 合成 lead 行），Lead 永远不会被判 finished。
 * rc.2 起宿主不再写 team/member（成员就是委派树里的 subagent）：候选集退化为 team/task 快照出现过的 ownerId，
 * 并用 rootId 把 Lead 自己排除（rc.2 的任务 owner 可以是 root 的 Session id）。
 * 零任务成员 → 曾完成过不成立 → 永不 finished。failed 成员不在本判定范围。
 * @param events - Lead（root）会话事件数组。
 * @param rootId - 团队 root（Lead）的会话 id；rc.2 用它排除 Lead，rc.1 形状（有 team/member 登记）不受影响。
 * @returns {{ finished: Set<string>, idsByName: Map<string, string> }} idsByName 把模型侧 target / owner 名字映射成成员 id（宿主 roster.ts:42-53 用名字寻址）。
 */
export function finishedMembers(events, rootId) {
  const idsByName = new Map()
  const lastTask = new Map()
  const everDone = new Set()
  const owners = new Set()
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'team/member') {
      const member = event?.data?.member
      if (typeof member?.id === 'string' && typeof member?.name === 'string') idsByName.set(member.name, member.id)
      continue
    }
    if (event?.type !== 'team/task') continue
    const task = event?.data?.task
    const ownerId = task?.ownerId
    if (typeof task?.id === 'string') lastTask.set(task.id, task)
    if (typeof ownerId === 'string') {
      owners.add(ownerId)
      if (task?.status === 'completed' || task?.status === 'deleted') everDone.add(ownerId)
    }
  }
  const openByOwner = new Map()
  for (const task of lastTask.values()) {
    const ownerId = task?.ownerId
    if (typeof ownerId !== 'string' || typeof task?.id !== 'string') continue
    if (task?.status === 'pending' || task?.status === 'in_progress') openByOwner.set(ownerId, (openByOwner.get(ownerId) ?? 0) + 1)
  }
  // 有 team/member 登记（rc.1）就只认登记过的成员；没有登记（rc.2）就认任务快照里的 ownerId，并排除团队 root。
  const candidates = idsByName.size > 0
    ? idsByName.values()
    : Array.from(owners).filter((ownerId) => ownerId !== rootId)
  const finished = new Set()
  for (const memberId of candidates) {
    if (everDone.has(memberId) && !openByOwner.has(memberId)) finished.add(memberId)
  }
  return { finished, idsByName }
}

/**
 * 会话在 Agent-Team 里的身份。
 * rc.1：宿主 `agentTeams.tryMembership` 还在时直接沿用，'lead' / 'teammate' / undefined 三种语义原样不变。
 * rc.2：该 API 已删除（docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents），改由委派树推导：
 *   ctx.subagents.rootOf(agent) 给出团队 root（Lead）会话；root 自身是 'lead'，
 *   root 的直接子级（delegationDepth === 1）就是团队成员，更深的后代返回 undefined，
 *   与旧版「provider 子代理没有 membership」同一条口径：不套成员门禁，也不套 Lead 门禁。
 * 身份来源缺失（服务没有 tryMembership 也没有 rootOf）或解析抛错时返回 undefined 并调用 onFailure，
 * 由调用方 fail-open 只 warn 一次；「不是成员」不是故障，不会触发 onFailure。
 * @param ctx - 宿主上下文。
 * @param agent - 待判定的 Agent。
 * @param onFailure - 身份来源不可用时的回调（只用于真正的不可用，不用于「非成员」）。
 * @returns { role, root, name? } 或 undefined。
 */
export function resolveMembership(ctx, agent, onFailure) {
  if (agent === undefined || agent === null) return undefined
  let agentTeams
  try {
    agentTeams = ctx?.get?.(AGENT_TEAMS_SERVICE)
  } catch (error) {
    onFailure?.(`服务 ${AGENT_TEAMS_SERVICE} 读取失败：${errText(error)}`)
    return undefined
  }
  if (typeof agentTeams?.tryMembership === 'function') {
    try {
      return agentTeams.tryMembership(agent)
    } catch (error) {
      onFailure?.(`服务 ${AGENT_TEAMS_SERVICE} 的 tryMembership 抛错：${errText(error)}`)
      return undefined
    }
  }
  // 没有 tryMembership 才走 rc.2 推导；两条路都没有就是身份不可用。
  let subagents
  try {
    subagents = ctx?.get?.('subagents')
  } catch (error) {
    onFailure?.(`服务 subagents 读取失败：${errText(error)}`)
    return undefined
  }
  if (typeof subagents?.rootOf !== 'function') {
    onFailure?.(`既无 ${AGENT_TEAMS_SERVICE}.tryMembership（rc.2 已删除），subagents 服务也没有 rootOf，无法判定成员身份`)
    return undefined
  }
  let root
  try {
    root = subagents.rootOf(agent)
  } catch (error) {
    onFailure?.(`subagents.rootOf 抛错：${errText(error)}`)
    return undefined
  }
  if (root === undefined || root === null) return undefined
  if (root === agent || root.id === agent.id) return { role: 'lead', root }
  if (delegationDepth(agent) !== 1) return undefined
  return { role: 'teammate', root, name: agent.name ?? String(agent.id) }
}

/** 会话在委派树里的深度：优先会话头 delegationDepth；读不到时只认「父会话就是 root」这一种可判定情形。 */
function delegationDepth(agent) {
  const headerDepth = agent?.session?.header?.delegationDepth
  if (Number.isSafeInteger(headerDepth) && headerDepth >= 0) return headerDepth
  return undefined
}

/** 该 Agent 是否就是团队 root（Lead）。 */
function isTeamRoot(ctx, agent) {
  const membership = resolveMembership(ctx, agent)
  return membership?.role === 'lead'
}

// 包裹标记打在包装函数自身（不是原方法）：dispose 后原方法不带标记，二次 apply 才会重新包裹；Symbol.for 让重复加载共用同一标记。
const ROUTE_WRAPPED = Symbol.for('force-subagent.team-member-route')

const COMMAND_NAME = 'using-agent-team'
const SECTION_NAME = 'force-subagent:agent-team'
// director 的 orchestrate section 用 55；57 相邻但不与宿主 SECTION_ORDERS 撞值。
const SECTION_ORDER = 57

const LEAD_NUDGE = '本会话已启用 Agent-Team 强制委派提示（/using-agent-team off 可关闭）。Lead：不要独自实现；先用 team_task_create 把工作拆成互不依赖的小任务（blocked_by 只写真实依赖、write_scopes 互斥），再在单轮内并行 subagent 拉起全部初始成员（需要继承本会话上下文用 subagent_fork），记下每个成员返回的 agent id，不要串行建一个等一个；然后先推进可做的工作，仅在确实被阻塞时才 wait_agent 一次（同一 turn 不得连续两次），收到结果立即处理；你只做架构、拆解、调度、仲裁与最终验收，细节实现全部派发。【Lead 委派提醒，每轮首次动这些工具会收到一次】你自己动取证工具 bash / pwsh / read / read_image / grep / glob / web_fetch / web_search，自己动实现工具 write / edit / apply_patch / str_replace_editor，或自己动执行工具 run_code / terminal_open / terminal_read / terminal_send / terminal_signal（run_code 能在程序里读文件、写文件、跑命令；terminal_* 是跨 turn 存活的持久 shell），本轮还没有 subagent / subagent_fork 派发时，每轮首次动这些工具会收到一条前缀 [team-gate] 的提醒，工具照常执行；收到新消息开新一轮后，同一判据会再提醒一次。正确做法是先 team_task_create 拆分任务，再在单轮内并行 subagent 派成员承接；本轮已经派发过就不再重复提醒。'

/** flat 模式追加在 Lead nudge 之后的一节：成员收敛动作 + 宿主无删除成员 API 的事实，防止模型假装删除成员。 */
const FLAT_LEAD_APPENDIX = '\n\n【flat 模式：只用成员，不派子代理】成员就是你在委派树里直接派出的 subagent，自己执行，成员的 subagent / subagent_fork / subagent_role / close_subagent / workflow 会被门禁放行但立即提醒（提醒前缀 [team-gate]）。你每收到一条成员消息，必须先判定该成员本次任务是否完成：已完成 → 立即 interrupt_agent(agent_id=该成员) 中断该成员，并用 team_task_update 关闭对应任务，此后永不再向该成员 send_message、不得复用该成员；未完成 → 继续给该成员派活。这条不靠提示词自觉也不靠硬拦：向已完成成员 send_message、或把任务 team_task_update 的 claim / reassign 落到已完成成员头上，工具调用仍会成功，但门禁会立即投递一条前缀 [team-gate] TEAM_MEMBER_FINISHED: 的提醒——看到它就该收手。需要新活就再 subagent 派一个新成员承接（send_message / interrupt_agent 都用 list_agents 给出的 agent_id，不再用别名）。构建团队时把工作拆成互不依赖的小任务（write_scopes 互斥、blocked_by 只写真实依赖），在单轮内并行 subagent 多个成员一次拉齐，不要串行建一个等一个。注意：宿主没有删除成员的 API（没有删除工具），软踢出只能做到「interrupt_agent 中断其当前 turn + 不再 send_message 唤醒」，委派记录仍然存在——不要声称或假装删除成员。【flat 模式 Lead 提醒同样生效】flat 不放宽 Lead 门禁：Lead 自己的实现工具 write / edit / apply_patch / str_replace_editor、取证工具 bash / pwsh / read / read_image / grep / glob / web_fetch / web_search 与执行工具 run_code / terminal_open / terminal_read / terminal_send / terminal_signal，本轮还没有 subagent 派发时，每轮首次动这些工具会收到一条前缀 [team-gate] 的提醒，工具照常执行，新的 turn 开始后会再提醒一次。实现与取证都必须委派：出路是先 team_task_create 拆分，再在单轮内并行 subagent 让成员承接；成员自己执行这些工具不受该提醒约束。'

// 成员会话没有自己的 command/run 记录，门控改由 Lead 会话的开关派生（见 text 回调与 tools/pre-execute 监听）。
const MEMBER_NUDGE = '你是 Agent-Team 成员（rc.2：你就是 Lead 直接派出的一个 subagent，靠 agent_id 被寻址）。本会话的 Lead 已启用强制委派提示（/using-agent-team off 可关闭）：除编排类与只读工具（subagent / subagent_fork / subagent_role / close_subagent / workflow / team_task_* / send_message / wait_agent / list_agents / interrupt_agent / job_* / skill / todo_write / read / grep / glob）外，其余工具会被门禁放行但立即提醒，仍必须委派；你只是编排者，加载必需技能后，本轮第一个业务工具调用必须是委派（subagent / subagent_fork / workflow），拆分子任务（写范围互斥）后单轮批量派发并在 team_task_* 看板登记；宿主对委派深度有硬上限（subagent 服务的 maxDepth），派不出就是它太小，回报 Lead 调整而不是自己硬撑；只有 read、grep、glob 可自己用来校验产物，自己只做拆分、合并与校验；阻塞时 wait_agent 只等一次，同一 turn 不得连续两次，收到结果立即处理。'

/** flat 模式的成员提示词：整段替换 MEMBER_NUDGE。追加式写法会在同一段提示里既要求委派又宣布作废，模型两头都能挑；替换式没有这个矛盾，也更短。 */
const MEMBER_NUDGE_FLAT = '你是 Agent-Team 成员（flat 模式：本团队只用成员、不派子代理；你就是 Lead 直接派出的一个 subagent，靠 agent_id 被寻址）。本会话的 Lead 已启用强制委派提示（/using-agent-team off 可关闭）：subagent / subagent_fork / subagent_role / close_subagent / workflow 会被门禁放行但立即提醒，你自己执行分给你的任务——read / grep / glob 取证、write / edit 改代码、bash 跑命令与跑测试都由你完成；用 team_task_* 看板登记进度，完成后用 send_message 把结果交回 Lead（agent_id 用 list_agents 给出的 Lead 会话 id），由 Lead 判定完成并 interrupt_agent 收敛你；宿主没有删除成员的 API，不要声称或假装删除成员。你所在团队的构建方式：Lead 把工作拆成互不依赖的小任务（write_scopes 互斥）并在单轮内并行 subagent 多个成员，不要串行建一个等一个——所以你只管自己这一小块，做完立即交回，不要等其它成员。'

/** 开启且带 task 时，section 在 nudge 之后追加持续有效的任务段。 */
const TASK_PREFIX = '\n\n本会话任务（/using-agent-team 下达，持续有效）：'

const ENABLED_REMINDER = '【强制委派提醒】用户通过 /using-agent-team 开启本会话的 Agent-Team 强制委派（持续到 /using-agent-team off）。你是 Lead：只做架构、拆解、调度、仲裁与最终验收；实现与测试必须委派。'
const ENABLED_TASK_REMINDER = (task) => `【强制委派提醒】用户通过 /using-agent-team 开启本会话的 Agent-Team 强制委派，并下达任务（本会话持续有效，/using-agent-team off 关闭）：\n${task}\n你是 Lead：只做架构、拆解、调度、仲裁与最终验收；实现与测试必须用 team_task_* 登记后批量 subagent 委派。`
const DISABLED_REMINDER = '【强制委派提醒已关闭】用户执行 /using-agent-team off：本会话不再强制委派，按普通方式处理。'

const reminderText = (state) =>
  !state.enabled ? DISABLED_REMINDER
    : state.task === undefined ? ENABLED_REMINDER
      : ENABLED_TASK_REMINDER(state.task)

const summaryText = (state) =>
  !state.enabled ? '已关闭强制委派'
    : state.task === undefined ? '已开启强制委派'
      : `已开启强制委派：${state.task.slice(0, 40)}`

const resultText = (state) =>
  !state.enabled ? '已关闭 Agent-Team 强制委派提醒。'
    : state.task === undefined ? '已开启 Agent-Team 强制委派提醒。用 /using-agent-team off 关闭。'
      : '已开启 Agent-Team 强制委派，任务已转交给模型。用 /using-agent-team off 关闭。'

/** 模型可见提醒消息（UserMessage 形态）：宿主 UI 按 source.kind/form 归类为 notice。 */
function buildNotice(state) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: reminderText(state) }],
    source: { kind: 'force-subagent', form: 'notice', summary: summaryText(state) },
  }
}

/**
 * 投递一条 notice。宿主 Agent 恒有 steer/inject，方法缺失（非宿主形态、测试替身）就跳过不抛错；
 * 投递失败只 warn 一次，命令仍返回 success——提示注入失败不该让用户的命令报错。
 */
function deliver(agent, method, message, warn) {
  const send = agent?.[method]
  if (typeof send !== 'function') return
  try {
    send.call(agent, message)
  } catch (error) {
    warn(`模型可见提醒投递（agent.${method}）失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 放行白名单：nested 成员只有精确命中的编排类与只读工具直接放行（不再走点名提醒），其余工具提醒一次后照常执行；插件不拒绝任何成员工具（前缀匹配会放过 mcp__ 委派工具，故不用）。 */
const ALLOWED_TOOLS = new Set([
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
  'job_list',
  'job_output',
  'job_kill',
  'skill',
  'todo_write',
  'read',
  'grep',
  'glob',
])

const isAllowedTool = (name) => typeof name === 'string' && ALLOWED_TOOLS.has(name)

/** nested 模式成员越界的软提醒：工具已放行，文案直接给出正确做法（委派 + 看板登记）。 */
const memberGateReminder = (tool) =>
  `[team-gate] 提醒：Agent-Team 成员不该直接执行「${tool}」——本次已放行，但 nested 模式的正确做法是用 subagent / subagent_fork / workflow 委派子任务并在 team_task_* 登记；自己只做拆分、合并与校验。`

/** flat 模式下封死成员派子代理的工具集：ALLOWED_TOOLS 里的全部委派入口（少了 subagent_role / close_subagent 就会被绕过），其余工具一律由成员自己执行。 */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'subagent_role', 'close_subagent', 'workflow'])

/** flat 模式成员试图派子代理的软提醒：放行 + 点名 flat 模式的正确动作。 */
const flatGateReminder = (tool) =>
  `[team-gate] 提醒：flat 模式只用成员，成员不派子代理——「${tool}」本次已放行，但它不是成员的动作：读文件、改代码、跑命令、跑测试一律由你自己执行，做完后用 send_message 把结果交回 Lead，由 Lead 判定完成并 interrupt_agent 收敛你。`

/**
 * Lead 取证提醒的点名工具：只列「取证 / 执行动作」（跑命令、读文件、读图片、搜内容、列文件、抓网页、搜网页），
 * 针对的是 Lead 自己下场取证而不是委派；命中只投递提醒，工具照常执行。
 * 旁路补齐：`read_image` 是真实的取证入口（读文件类的图片版），宿主注册名见
 * packages/fs/tool-fs/src/read-image.ts:211；`pwsh` 是 bash 的 PowerShell 等价物（同一执行能力，注册名见
 * packages/shell/tool-pwsh/src/index.ts:385）。持久化 pwsh（packages/shell/tool-pwsh-persistent/src/index.ts:428）
 * 注册的模型可见工具名同样是 `pwsh`，与 tool-pwsh 共用同一个名字，因此一条 'pwsh' 同时覆盖前台与持久化两条路。
 * 已知未覆盖：MCP 工具（模型可见名为 `mcp__<server>__<tool>`，由服务器自行决定、逐名点名不可行）不进本集合，
 * 只靠 LEAD_NUDGE 的委派要求承担告知。
 */
const EVIDENCE_TOOLS = new Set(['bash', 'read', 'grep', 'glob', 'web_fetch', 'web_search', 'read_image', 'pwsh'])

/**
 * Lead 实现工具的点名工具：覆盖「Lead 被提醒取证后转而直接 write / edit 把活做掉」这条绕行——只提醒取证不提醒动手
 * 等于门禁没有生效。名字逐个核对宿主注册名：write 见 packages/fs/tool-fs/src/write.ts:74，
 * edit 见 edit.ts:86，apply_patch 见 apply-patch.ts:27，str_replace_editor 见
 * packages/fs/tool-str-replace-editor/src/index.ts:430；宿主不存在 multi_edit 一类名字，一律不列。
 */
const IMPLEMENTATION_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

/**
 * Lead 执行面工具的点名工具：覆盖「Lead 被提醒 bash / write 之后改用宿主留下的另外两条执行通道」这条绕行——
 * 提醒针对的是「Lead 亲自干活」这件事，不是某两个工具名。名字逐个核对宿主 0.2.2-rc.1 真实注册名：
 * `run_code` 见 packages/core/tool-executor-ptc/src/ptc.ts:298（`defineTool({ name: RUN_CODE_NAME })`，
 * 常量值 'run_code' 见 packages/core/tools/src/contracts.ts:12），模型可见名表见
 * packages/core/tools/tests/gen-tool-catalog.spec.ts:36；它是取证 + 实现的等价组合——程序内可经 SDK 再派发
 * 其它 agent-visible 工具，只提醒 bash / write 不提醒它等于门禁形同虚设。
 * `terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` 见
 * packages/experimental/tool-terminal/src/index.ts:166 / :203 / :307 / :340（模型可见名表见同 spec :41-42）：
 * 持久终端会话就是可跨 turn 存活的 bash，宿主只有这一个注册点（tool-terminal 一个包同时提供持久与非持久后端，
 * 名字同一，一条覆盖两条路），没有第二个副本需要补。
 * `terminal_close`（:365）/ `terminal_list`（:396）刻意不列：它们只是终端会话的生命周期簿记，自身不执行任何
 * 东西，而终端只能由已在集合内的 `terminal_open` 建立——Lead 拿不到可操作的终端。
 */
const EXECUTION_TOOLS = new Set(['run_code', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal'])

/** Lead 侧提醒触发集合 = 取证类 + 实现类 + 执行类：命中它只触发「本轮未派发」提醒，不构成拦截，插件不因此拒绝任何工具调用。委派与编排类工具（team_task_* / subagent 系列 / send_message / wait_agent / list_agents / interrupt_agent）一律不在其列。 */
const LEAD_BLOCKED_TOOLS = new Set([...EVIDENCE_TOOLS, ...IMPLEMENTATION_TOOLS, ...EXECUTION_TOOLS])

/** 「本轮已经把活派出去了」的判据：本 turn 内出现过委派类 tool/call 事件。spawn_teammate 只在 rc.1 存在，保留是为了同一份判据在 rc.1 上仍然成立。 */
const DISPATCH_TOOLS = new Set(['spawn_teammate', 'subagent', 'subagent_fork', 'subagent_role', 'workflow'])

/** 被点名工具在提醒文案里的归类名：实现类 / 执行类 / 取证类。三类的判据与出路完全相同，只有称呼不同。 */
const leadGateToolCategory = (tool) => {
  if (IMPLEMENTATION_TOOLS.has(tool)) return '实现工具'
  if (EXECUTION_TOOLS.has(tool)) return '执行工具'
  return '取证工具'
}

/** Lead 本轮未派发时的提醒正文：点名工具（取证类 / 实现类 / 执行类）与正确做法；工具照常执行，不构成拒绝。 */
const leadGateReminder = (tool) =>
  `[team-gate] 提醒：本轮还没有派发成员，${leadGateToolCategory(tool)}「${tool}」仍会照常执行。正确做法：先 team_task_create 把工作拆成互不依赖的小任务（write_scopes 互斥、blocked_by 只写真实依赖），再在单轮内 subagent 并行派成员承接${EXECUTION_TOOLS.has(tool) ? '——执行工具本身就是取证与实现的等价通道' : ''}。实现与取证都必须委派，Lead 只做拆分、派发、合并与校验；本轮派发之后不再重复提醒，新的 turn 开始后会再提醒一次。`

const waitGateReminder = () =>
  '[team-gate] 提醒：连续两次 wait_agent 之间没有任何有效动作，本次等待已放行，但同一 turn 只允许等待一次。先用 list_agents 与 team_task_list 处理已有结果（已结束的队友、completed/ready 任务），或直接推进任务。'

/** 已完成成员门禁的软提醒文案：点名被劝阻的动作与成员，并给出唯一出路（新建成员）。前缀 [team-gate] TEAM_MEMBER_FINISHED: 保持不变，供测试断言。 */
const finishedMemberReminder = (subject) =>
  `[team-gate] TEAM_MEMBER_FINISHED: ${subject} 已被判定为「已完成任务」——其名下任务全部处于 completed / deleted。本次调用已放行，但已完成成员不能再承接新任务：宿主没有删除成员的 API，interrupt_agent 也只中断 turn 不删记录，成员在委派记录里仍然存在。正确做法是再 subagent 派一个新成员承接，并给它建新的 team_task；不要继续向该成员 send_message，也不要把任务 claim / reassign 给它。`

/**
 * 命令输入 → 会话状态。空串与 `on`（忽略大小写）= 开启且无 task；`off` = 关闭；
 * 其它文本 = 开启并把原文（已去首尾空白）作为 task。
 */
export function parseCommandInput(args) {
  const text = String(args ?? '').trim()
  if (text.length === 0 || text.toLowerCase() === 'on') return { enabled: true }
  if (text.toLowerCase() === 'off') return { enabled: false }
  return { enabled: true, task: text }
}

/** section 文本：关闭为空串；开启为 nudge，带 task 时追加持续有效的任务段。 */
const promptText = (state, nudge) =>
  state.enabled ? nudge + (state.task === undefined ? '' : TASK_PREFIX + state.task) : ''

/** 会话最后一次 /using-agent-team 记录解析出的状态；无记录为关闭。事件不可读时抛 TypeError。 */
export function commandState(session) {
  const events = readEvents(session)
  if (events === undefined) {
    throw new TypeError('session 未暴露 events 数组或 snapshotEvents()')
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'command/run' || event?.data?.name !== COMMAND_NAME) continue
    return parseCommandInput(event.data.args)
  }
  return { enabled: false }
}

/** 门禁用的开关判定：`commandState(session).enabled` 的薄封装。 */
const enabledIn = (session) => commandState(session).enabled

/**
 * 取会话事件。真实 Session 的事件日志是私有的，只暴露 snapshotEvents()
 * （packages/core/session/src/index.ts:725-734）；兼容测试或其它实现直接给出的
 * events 数组（director 的 extractSessionEvents 同样做双路径，orchestrate.ts:80-96）。
 */
function readEvents(session) {
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    if (Array.isArray(events)) return events
  }
  return undefined
}

/** 本插件的 loader entry id；settings.describe() 的 ns 就是它。 */
const ENTRY_ID = 'dsh-force-subagent'

/** 实时配置读取失败只告警一次。 */
let warnedLiveConfig = false

/**
 * 激活时实时读取当前配置。设置文档写入不触发插件热重载，apply 时的快照会过期。
 * describe 抛错 / settings 缺失 → 回退 fallbackConfig（warn-once，不静默）。
 * describe 提供了本命名空间但 value 为空对象 → 视为用户清空，直接用空对象，不回退。
 * @param ctx - 宿主上下文。
 * @param fallbackConfig - apply 时收到的配置。
 * @returns 原样配置对象（调用方负责 resolveConfig）。
 */
export function liveConfig(ctx, fallbackConfig) {
  try {
    const settings = ctx?.get?.('settings')
    if (settings !== undefined && settings !== null && typeof settings.describe === 'function') {
      const rows = settings.describe()
      const row = Array.isArray(rows)
        ? rows.find((item) => item !== null && typeof item === 'object' && item.ns === ENTRY_ID)
        : undefined
      if (row !== undefined && row.value !== undefined && row.value !== null) return row.value
    }
  } catch (error) {
    if (!warnedLiveConfig) {
      warnedLiveConfig = true
      ctx?.logger?.warn?.(`[force-subagent] 读取实时设置失败，回退 apply 时的配置：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return fallbackConfig
}

/* ────────────────────── 成员容量：读取 / 设置（rc.2：subagent 服务的 maxActiveSubagents / maxDepth） ────────────────────── */

/** TeamService 的注册名（rc.1 / rc.2 编译产物均为 `super(ctx, "agentTeams")`）。 */
const AGENT_TEAMS_SERVICE = 'agentTeams'
/** 成员容量所在的 settings 命名空间，就是 rc.2 profile 的条目 id（packages/bundle/base/cordis.patch.yml:363 `- id: subagent`）。 */
export const CAPACITY_NS = 'subagent'
/** rc.2 的容量旋钮：同时活着的 continuable 子代理数量上限（packages/subagent/subagent/src/index.ts:197，volatile）。 */
export const CAPACITY_LIMIT_KEY = 'maxActiveSubagents'
/** rc.2 的深度旋钮：委派树绝对深度上限（同文件 :196，volatile）。nested 模式让成员再派子代理需要 ≥ 2。 */
export const CAPACITY_DEPTH_KEY = 'maxDepth'
/** 命令名（宿主命令服务的 name 用小写、不带斜杠）。 */
const LIMIT_COMMAND_NAME = 'team-limit'

const errText = (error) => (error instanceof Error ? error.message : String(error))
const valueText = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))

/** 读取结果里 source 的人话说明。插件不再读也不写任何 patch 文件，所以只剩服务与 settings 文档两条来源。 */
const CAPACITY_SOURCE_LABEL = {
  service: '运行中的 subagent 服务',
  settings: 'settings 文档（由宿主写进 profile 层 patch 并即时生效）',
  unknown: '读不到（宿主未暴露 subagent 服务，也没有 settings 文档里的该命名空间）',
}

/**
 * 校验容量取值：整数、≥ 1、≤ MAX_CAPACITY_LIMIT。
 * @param value - 数字或数字字符串。
 * @returns { limit } 或 { error }
 */
export function toCapacity(value) {
  let numeric
  if (typeof value === 'number') numeric = value
  else if (typeof value === 'string' && /^\+?\d+$/.test(value.trim())) numeric = Number(value.trim())
  else return { error: `取值必须是整数（收到 ${valueText(value)}）` }
  if (!Number.isSafeInteger(numeric)) return { error: `取值不是安全整数（收到 ${valueText(value)}）` }
  if (numeric < 1) return { error: `取值必须 ≥ 1（收到 ${numeric}）` }
  if (numeric > MAX_CAPACITY_LIMIT) return { error: `取值超过护栏上限 ${MAX_CAPACITY_LIMIT}（收到 ${numeric}）` }
  return { limit: numeric }
}

/**
 * 校验深度取值：整数、≥ 0（宿主 zod 为 min(0)）、≤ MAX_CAPACITY_LIMIT。
 * @param value - 数字或数字字符串。
 * @returns { depth } 或 { error }
 */
export function toDepth(value) {
  let numeric
  if (typeof value === 'number') numeric = value
  else if (typeof value === 'string' && /^\+?\d+$/.test(value.trim())) numeric = Number(value.trim())
  else return { error: `深度取值必须是整数（收到 ${valueText(value)}）` }
  if (!Number.isSafeInteger(numeric)) return { error: `深度取值不是安全整数（收到 ${valueText(value)}）` }
  if (numeric < 0) return { error: `深度取值必须 ≥ 0（收到 ${numeric}）` }
  if (numeric > MAX_CAPACITY_LIMIT) return { error: `深度取值超过护栏上限 ${MAX_CAPACITY_LIMIT}（收到 ${numeric}）` }
  return { depth: numeric }
}

/** 取宿主 settings 服务；缺失或 get 抛错都 warn 出来，不静默。 */
function getSettingsService(ctx, warn) {
  try {
    return ctx?.get?.('settings')
  } catch (error) {
    warn(`读取 settings 服务失败：${errText(error)}`)
    return undefined
  }
}

/** 取宿主 subagent 服务实例；缺失或 get 抛错都 warn 出来，不静默。 */
function getSubagentService(ctx, warn) {
  try {
    return ctx?.get?.('subagents')
  } catch (error) {
    warn(`读取 subagents 服务失败：${errText(error)}`)
    return undefined
  }
}

/**
 * 从 settings.describe() 里取 `subagent` 命名空间的当前值。
 * @param settings - 宿主 settings 服务（可为 undefined）。
 * @returns { limit, depth, revision }，取不到的字段为 undefined。
 */
function capacityFromSettings(settings) {
  if (settings === undefined || settings === null || typeof settings.describe !== 'function') {
    return { limit: undefined, depth: undefined, revision: undefined }
  }
  const rows = settings.describe()
  const row = Array.isArray(rows)
    ? rows.find((item) => item !== null && typeof item === 'object' && item.ns === CAPACITY_NS)
    : undefined
  const value = unwrapVolatile(row?.value)
  const numbers = (key) => {
    const raw = unwrapVolatile(value?.[key])
    return Number.isSafeInteger(raw) ? raw : undefined
  }
  return { limit: numbers(CAPACITY_LIMIT_KEY), depth: numbers(CAPACITY_DEPTH_KEY), revision: row?.revision }
}

/**
 * 读当前成员容量：运行中的 subagent 服务 Config → settings 文档 → 读不到。
 * 不回退内置默认、不读 patch 文件：读不到就如实给出 source='unknown'，由面板与命令把话说清楚。
 * @param ctx - 宿主上下文。
 * @param options - { subagents, settings } 仅供测试注入。
 * @returns { ok: true, limit, depth, source } 或 { ok: false, error }
 */
export function readCapacity(ctx, options = {}) {
  const warn = (detail) => ctx?.logger?.warn?.(`[force-subagent] ${detail}`)
  const subagents = 'subagents' in options ? options.subagents : getSubagentService(ctx, warn)
  const fromService = (key) => {
    const raw = unwrapVolatile(subagents?.config?.[key])
    return Number.isSafeInteger(raw) ? raw : undefined
  }
  const serviceLimit = fromService(CAPACITY_LIMIT_KEY)
  const serviceDepth = fromService(CAPACITY_DEPTH_KEY)
  if (serviceLimit !== undefined) return { ok: true, limit: serviceLimit, depth: serviceDepth, source: 'service' }
  const fromSettings = capacityFromSettings('settings' in options ? options.settings : getSettingsService(ctx, warn))
  if (fromSettings.limit !== undefined) {
    return { ok: true, limit: fromSettings.limit, depth: serviceDepth ?? fromSettings.depth, source: 'settings' }
  }
  const notes = []
  if (subagents === undefined || subagents === null) notes.push(`${CAPACITY_NS} 服务不可用`)
  else notes.push(`${CAPACITY_NS} 服务上没有整数 ${CAPACITY_LIMIT_KEY}`)
  if (fromSettings.limit === undefined) notes.push(`settings 文档里的 ${CAPACITY_NS} 命名空间也没有 ${CAPACITY_LIMIT_KEY}`)
  warn(`成员容量读不到当前值：${notes.join('；')}。`)
  return { ok: false, error: `读不到 ${CAPACITY_NS}.${CAPACITY_LIMIT_KEY}：${notes.join('；')}`, limit: undefined, depth: fromSettings.depth }
}

/**
 * 写成员容量：只经 settings 服务写 `subagent` 命名空间的 volatile 字段（宿主负责持久化与即时生效）。
 * 插件自身不打开任何 cordis.patch.yml，也不改写别的插件实例。
 * @param ctx - 宿主上下文。
 * @param value - 容量输入（字符串或数字都接受）。
 * @param options - { settings, subagents, depth } 仅供测试注入；depth 一并写 maxDepth。
 * @returns { ok: true, limit, depth?, status } 或 { ok: false, error, limit? }
 */
export async function setCapacity(ctx, value, options = {}) {
  const warn = (detail) => ctx?.logger?.warn?.(`[force-subagent] ${detail}`)
  const parsed = toCapacity(value)
  if (parsed.error !== undefined) return { ok: false, error: `成员容量${parsed.error}` }
  const settings = 'settings' in options ? options.settings : getSettingsService(ctx, warn)
  if (settings === undefined || settings === null || typeof settings.update !== 'function') {
    return { ok: false, error: `宿主没有可用的 settings 服务，无法写入 ${CAPACITY_NS}.${CAPACITY_LIMIT_KEY}`, limit: parsed.limit }
  }
  const patch = { [CAPACITY_LIMIT_KEY]: parsed.limit }
  if (options.depth !== undefined) {
    const parsedDepth = toDepth(options.depth)
    if (parsedDepth.error !== undefined) return { ok: false, error: parsedDepth.error, limit: parsed.limit }
    patch[CAPACITY_DEPTH_KEY] = parsedDepth.depth
  }
  try {
    await settings.update(CAPACITY_NS, patch)
  } catch (error) {
    return { ok: false, error: `写入 ${CAPACITY_NS}.${CAPACITY_LIMIT_KEY} 失败：${errText(error)}`, limit: parsed.limit }
  }
  const read = readCapacity(ctx, options)
  const writtenDepth = patch[CAPACITY_DEPTH_KEY]
  const status = {
    state: read.ok ? (read.limit === parsed.limit ? 'applied' : 'unread') : 'unknown',
    requested: parsed.limit,
    limit: read.ok ? read.limit : parsed.limit,
    depth: read.depth ?? writtenDepth,
    source: read.ok ? read.source : 'unknown',
    message: read.ok
      ? (read.limit === parsed.limit
        ? `已写入 ${CAPACITY_NS}.${CAPACITY_LIMIT_KEY}=${parsed.limit}（宿主持久化并即时生效）`
        : `已写入，但回读当前值为 ${valueText(read.limit)}，与写入值 ${parsed.limit} 不一致`)
      : `已写入，但回读当前值失败：${read.error}`,
  }
  if (!read.ok) warn(`成员容量已写入但回读当前值失败：${read.error}`)
  if (status.state === 'unread') warn(`成员容量写入 ${parsed.limit} 后回读为 ${valueText(read.limit)}`)
  return { ok: true, limit: parsed.limit, depth: writtenDepth, status }
}

/** 容量来源的人话标签（供面板与命令文案复用）。 */
export const capacitySourceLabel = (source) => CAPACITY_SOURCE_LABEL[source] ?? String(source)

export function apply(ctx, config = {}) {

  // 关闭宿主自动设置页：本插件自带浏览器页面与侧栏图标，避免设置对话框里多出一个重复的齿轮入口
  // （外壳 SettingsRoot.tsx:32-39 对未知分区 id 一律渲染齿轮）。
  // auto 只写进描述符的 autoGenerate 字段，不影响命名空间出现在 describe() 里，也不影响
  // configForms 的读写（packages/settings/settings/src/index.ts:312 / 315 / 326）。
  // 用延迟注入而不是把 'settings' 写进 inject：inject 缺服务会让整个插件不 apply（门禁静默失效），
  // 而关闭自动设置页只是 UI 优化，不能拿门禁可用性去换。settings 就绪后再注册策略。
  if (typeof ctx.inject !== 'function') {
    ctx.logger?.warn?.('[force-subagent] ctx.inject 不可用，宿主自动设置页未关闭（设置里可能出现重复入口）。')
  } else ctx.inject(['settings'], (child) => {
    if (typeof child?.effect !== 'function') {
      // 不静默：注入上下文不合契约时也要留下可见痕迹，否则自动设置页没关也无人知晓。
      ctx.logger?.warn?.('[force-subagent] settings 注入上下文缺少 effect，宿主自动设置页未关闭（设置里可能出现重复入口）。')
      return
    }
    child.effect(() => {
      if (typeof child.settings?.configure !== 'function') {
        ctx.logger?.warn?.('[force-subagent] settings 服务缺少 configure 方法，宿主自动设置页未关闭（设置里可能出现重复入口）。')
        return () => {}
      }
      try {
        return child.settings.configure({ auto: false }, ctx.fiber)
      } catch (error) {
        ctx.logger?.warn?.(`[force-subagent] 宿主自动设置页未关闭：${error instanceof Error ? error.message : String(error)}`)
        return () => {}
      }
    }, 'force-subagent: settings page policy')
  })

  // 成员容量与嵌套深度不在本插件的命名空间：面板直接读写 `subagent` 命名空间，/team-limit 走 setCapacity；
  // 插件不监听 settings/document-updated，也不写任何 patch 文件（rc.2 的 agent-team 不接受成员上限键）。
  // 降级只 warn 一次：门禁评估发生在每次工具调用上，逐次 warn 会刷屏。warn 必须点名缺失服务与放行后果。
  let warnedFailOpen = false
  const warnFailOpen = (tool, detail) => {
    if (warnedFailOpen) return
    warnedFailOpen = true
    ctx.logger?.warn?.(`[force-subagent] ${detail}，门禁未生效，本次放行「${tool}」。`)
  }
  /** 配置解析告警出口：mode 非法取值经 normalizeMode 全局只 warn 一次。 */
  const configWarn = (detail) => ctx.logger?.warn?.(`[force-subagent] ${detail}`)
  /**
   * 软门禁提醒：门禁只判定、不拦截——工具调用照常放行，这里补一条模型可见的 notice。
   * 通道复用命令 handler 的既有先例（agent.inject + UserMessage 形态的 notice，见 buildNotice/deliver），不自造通道。
   * 去重口径：同一会话（agent.session 对象，回退 agent 对象）同一 key 只投递一次，避免逐次工具调用刷屏。
   * fail-open：投递失败（无 inject 方法 / inject 抛错）只 warn，绝不影响工具调用结果。
   */
  /** 已提醒过的 (会话, key)：WeakMap 按会话对象挂 Set，与 memberReadFailures 的 WeakSet 同一去重口径，随会话回收、无需容量上限。 */
  const remindedKeys = new WeakMap()
  let warnedRemindChannel = false
  const remindOnce = (agent, key, text) => {
    const scope = agent?.session !== null && typeof agent?.session === 'object' ? agent.session : agent
    if (scope === null || typeof scope !== 'object') return
    let seen = remindedKeys.get(scope)
    if (seen === undefined) {
      seen = new Set()
      remindedKeys.set(scope, seen)
    }
    if (seen.has(key)) return
    seen.add(key)
    if (typeof agent?.inject !== 'function') {
      if (!warnedRemindChannel) {
        warnedRemindChannel = true
        ctx.logger?.warn?.('[force-subagent] 会话 Agent 无 inject 方法，软门禁提醒未投递（工具调用照常放行）。')
      }
      return
    }
    deliver(
      agent,
      'inject',
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'force-subagent', form: 'notice', summary: text.slice(0, 40) },
      },
      (detail) => ctx.logger?.warn?.(`[force-subagent] ${detail}，工具调用照常放行。`),
    )
  }
  /** 实时 mode：只有全局设置这一个来源（页面也只有一个下拉）。读配置失败沿用现成 fail-open：liveConfig 已 warn-once 回退 apply 快照，返回值只会是 'flat' 或 'nested'。 */
  const modeFor = () => resolveConfig(liveConfig(ctx, config), configWarn).mode

  // 成员软门禁：不依赖提示词自觉，判定发生在工具执行前，但只放行 + 提醒，不再拦死工具调用。监听器抛异常会让工具整体失败，故自带 catch 兜底放行。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = exec?.name
    try {
      const agent = exec?.agent
      if (agent === undefined) return next()
      // 身份判定：rc.1 走 agentTeams.tryMembership，rc.2 走 ctx.subagents.rootOf（见 resolveMembership）。
      let identityUnavailable = false
      const membership = resolveMembership(ctx, agent, (detail) => {
        identityUnavailable = true
        warnFailOpen(tool, detail)
      })
      if (identityUnavailable) return next()
      // wait_agent 空转拦截：判据只看「本 turn 内上一次工具调用是否也是 wait_agent」——相邻两次
      // wait_agent 之间没有任何有效动作，只说明在空转。不用成员状态 API，避免依赖未验证的接口。
      // 门控：空转拦截只在 /using-agent-team 开启时生效。成员会话没有自己的 command/run 记录，
      // 开关语义必须取 root 会话（同下方成员门禁 enabledIn(membership.root?.session)）。
      if (tool === 'wait_agent') {
        const gateSession = membership?.root?.session ?? agent?.session
        let waitGateEnabled = false
        try {
          waitGateEnabled = gateSession !== undefined && gateSession !== null && enabledIn(gateSession) === true
        } catch (error) {
          // 开关读不到 → 与其它门禁同策略 fail-open：warn 一次后按普通方式处理。
          warnFailOpen(tool, `wait_agent 空转拦截读取开关状态失败：${error instanceof Error ? error.message : String(error)}`)
        }
        if (waitGateEnabled) {
          const waitSession = agent?.session
          if (waitSession !== undefined && waitSession !== null) {
            let waitEvents
            try {
              waitEvents = readEvents(waitSession)
            } catch (error) {
              warnFailOpen(tool, `wait_agent 空转拦截读取会话事件失败：${error instanceof Error ? error.message : String(error)}`)
              waitEvents = undefined
            }
            if (Array.isArray(waitEvents)) {
              let lastTurnStart = -1
              for (let index = waitEvents.length - 1; index >= 0; index -= 1) {
                if (waitEvents[index]?.type === 'turn/start') {
                  lastTurnStart = index
                  break
                }
              }
              const turnEvents = lastTurnStart < 0 ? waitEvents : waitEvents.slice(lastTurnStart + 1)
              // 宿主在 prepare(call.exec) 之前就把本次调用自身的 tool/call 写入 session
              // （packages/core/agent-loop/src/tool-calls.ts:168→170），不排除就会每次命中自己、每次都提醒。
              const currentCallId = exec?.callId
              let lastCall
              for (let index = turnEvents.length - 1; index >= 0; index -= 1) {
                const turnEvent = turnEvents[index]
                if (turnEvent?.type !== 'tool/call') continue
                if (currentCallId !== undefined && turnEvent?.data?.callId === currentCallId) continue
                lastCall = turnEvent
                break
              }
              if (lastCall?.data?.name === 'wait_agent') {
                remindOnce(agent, 'wait-spin', waitGateReminder())
                return next()
              }
            }
          }
        }
      }
      // 已完成成员门禁：send_message 复用已完成成员、team_task_update 把任务交给已完成成员，判定后放行并投递一次提醒。
      // 必须排在下面成员门禁之前——send_message / team_task_update 都在 ALLOWED_TOOLS 里，排后面会被
      // flat 的提前 return 或 nested 白名单放行短路。sender 是谁都拦（Lead 与其它成员同样受拦）。
      const callArgs = exec?.arguments !== null && typeof exec?.arguments === 'object' ? exec.arguments : undefined
      const callAction = typeof callArgs?.action === 'string' ? callArgs.action : undefined
      if (tool === 'send_message' || (tool === 'team_task_update' && (callAction === 'claim' || callAction === 'reassign'))) {
        // Team 事件只写在 Lead（root）会话上（宿主 journal.appendAndFlush(root, …)）；成员会话上没有，
        // 所以必须走 membership.root.session。读不到一律沿用既有 fail-open：warn 一次后放行。
        const teamSession = membership?.root?.session ?? agent?.session
        if (teamSession !== undefined && teamSession !== null) {
          let teamEvents
          let gateEnabled = false
          try {
            teamEvents = readEvents(teamSession)
            // 开关与其余三条门禁同一来源（成员会话没有自己的 command/run 记录）：
            // /using-agent-team off 时本门禁也完全不干预，保持插件「off 即不干预」的既有契约。
            gateEnabled = enabledIn(teamSession) === true
          } catch (error) {
            warnFailOpen(tool, `已完成成员门禁读取 Team 事件失败：${error instanceof Error ? error.message : String(error)}`)
            teamEvents = undefined
          }
          if (Array.isArray(teamEvents) && gateEnabled) {
            const { finished, idsByName } = finishedMembers(teamEvents, membership?.root?.id ?? teamSession?.id)
            let memberId
            let subject
            if (tool === 'send_message') {
              // rc.1 用名字寻址（target）；rc.2 的 send_message 只认 agent_id（Session id），名字寻址已删除。
              const name = typeof callArgs?.target === 'string' ? callArgs.target.trim() : ''
              const directId = typeof callArgs?.agent_id === 'string' ? callArgs.agent_id.trim() : ''
              memberId = idsByName.get(name) ?? (directId.length > 0 ? directId : undefined)
              subject = name.length > 0 ? `send_message 的目标成员「${name}」` : `send_message 的目标会话 ${directId}`
            } else if (callAction === 'claim') {
              // 宿主用名字寻址成员，但 claim 的承接者就是调用者本人，成员 id === 其 Agent id（roster.ts:96-98）。
              memberId = agent?.id
              subject = `claim 新任务的成员「${membership?.name ?? agent?.id}」（你自己）`
            } else {
              const name = typeof callArgs?.owner === 'string' ? callArgs.owner.trim() : ''
              memberId = idsByName.get(name)
              if (memberId === undefined && name.length > 0 && typeof ctx.get('subagents')?.resolveName === 'function') {
                // rc.2：看板 owner 仍是模型侧名字，宿主自己经 subagents.resolveName 解析成 Session id；门禁同一口径解析一次。
                try {
                  memberId = String(await ctx.get('subagents').resolveName(agent, name, exec.signal))
                } catch (error) {
                  // 名字解析不了（树里没有这个名字）就不是判定对象：按「判不了就不提醒」的既有口径放行，不 warn。
                  void error
                }
              }
              subject = `team_task_update action=reassign 指定的 owner「${name}」`
            }
            if (memberId !== undefined && finished.has(memberId)) {
              remindOnce(agent, `finished-member:${memberId}`, finishedMemberReminder(subject))
              return next()
            }
          } else if (!Array.isArray(teamEvents)) {
            warnFailOpen(tool, '已完成成员门禁读不到 Lead 会话事件（readEvents 无返回），无法判定成员是否已完成')
          }
        }
      }
      // Lead 自身也有 membership（role==='lead'），只拦 teammate；subagent 无 membership → undefined。
      if (membership?.role === 'teammate') {
        // flat 模式：成员自己执行，只封死派子代理这条路；白名单不再限制成员的其余工具。
        if (modeFor() === 'flat') {
          if (DELEGATION_TOOLS.has(tool) && enabledIn(membership.root?.session)) {
            remindOnce(agent, 'flat-delegation', flatGateReminder(tool))
          }
          return next()
        }
        // nested 模式（默认）：白名单短路只对成员生效——read / grep / glob 同时在 ALLOWED_TOOLS，若提前放行会绕过下面的 Lead 取证门禁。
        if (isAllowedTool(tool)) return next()
        // 开关取 Lead（root）会话：成员会话没有自己的 command/run 记录。
        if (enabledIn(membership.root?.session)) {
          remindOnce(agent, 'member-gate', memberGateReminder(tool))
        }
      }
      // Lead 门禁：补上成员门禁管不到的另一半——Lead 自己下场取证（bash / pwsh / read / read_image / grep / glob / web_fetch / web_search）、
      // 下场实现（write / edit / apply_patch / str_replace_editor）或下场执行（run_code / terminal_open / terminal_read /
      // terminal_send / terminal_signal），而不是 team_task_create 拆分后 spawn_teammate 交出去。
      // 只提醒取证不提醒动手没有意义：Lead 被提醒 bash 后转而 write / edit 就把活做掉了；同理转而
      // run_code（程序里读文件写文件跑命令）或 terminal_open（跨 turn 的持久 shell）同样把活做掉了。判定口径：会话已开启命令，且「本轮」
      // （事件里最后一个 turn/start 之后）没有委派类 tool/call（spawn_teammate / subagent 系列 / workflow），
      // 就投递一条提醒，工具照常执行。会话里是否还有 running 成员、本轮是否 interrupt_agent 过成员，都不参与判定；
      // 单靠 team_task_create 不算已派发。
      // 去重令牌 = 最后一个 turn/start 在事件序列里的下标：同一轮只提醒一次，新的 turn/start 到来 → 令牌变化 → 重新提醒一次。
      // 拿不到判定依据（无 session / 事件读不到 / 找不到 turn/start / 读取抛错）一律 fail-open：
      // 不提醒、放行工具调用，只 warn 一次，避免把宿主卡死或刷屏。
      if (membership?.role !== 'teammate' && LEAD_BLOCKED_TOOLS.has(tool)) {
        // 子代理（subagent/fork）同样没有 membership，且 fork 会继承父会话事件前缀；用会话头 delegationDepth≥1 排除，避免 Lead 派出的取证 subagent 被自家门禁拦死。
        let depth
        try {
          depth = agent?.session?.header?.delegationDepth ?? 0
        } catch (error) {
          warnFailOpen(tool, `Lead 门禁读取会话头 delegationDepth 失败：${error instanceof Error ? error.message : String(error)}`)
          return next()
        }
        if (Number(depth) >= 1) return next()
        const session = agent?.session
        if (session === undefined || session === null) {
          warnFailOpen(tool, '无法定位会话（exec.agent.session 缺失），无法判定本轮是否已 team_task_create')
          return next()
        }
        let enabled
        try {
          enabled = enabledIn(session)
        } catch (error) {
          warnFailOpen(tool, `Lead 门禁读取会话事件失败：${error instanceof Error ? error.message : String(error)}`)
          return next()
        }
        if (!enabled) return next()
        const events = readEvents(session)
        if (!Array.isArray(events)) {
          warnFailOpen(tool, '会话事件不可读（readEvents 无返回），无法判定本轮是否已 team_task_create')
          return next()
        }
        let turnStart = -1
        for (let index = events.length - 1; index >= 0; index -= 1) {
          if (events[index]?.type === 'turn/start') {
            turnStart = index
            break
          }
        }
        if (turnStart < 0) {
          warnFailOpen(tool, '会话事件中找不到 turn/start，无法判定「本轮」')
          return next()
        }
        const thisTurn = events.slice(turnStart + 1)
        let dispatchedAt = -1
        for (let index = 0; index < thisTurn.length; index += 1) {
          const called = thisTurn[index]?.type === 'tool/call' ? thisTurn[index]?.data?.name : undefined
          if (DISPATCH_TOOLS.has(called)) {
            dispatchedAt = index
            break
          }
        }
        if (dispatchedAt < 0) {
          // 轮次令牌 = 最后一个 turn/start 的下标：同轮只提醒一次，跨轮令牌变化后重新提醒一次。
          remindOnce(agent, `lead-evidence:${turnStart}`, leadGateReminder(tool))
        }
        return next()
      }
      return next()
    } catch (error) {
      warnFailOpen(tool, `成员门禁评估失败：${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
  })

  // 子代理模型路由：判别只看两件事——本会话 /using-agent-team 已开启，且 spec.provider 对应的
  // provider 声明了 capabilities.agentOptions（公开访问器 subagents.getProvider，见
  // subagent/src/index.ts:573-575；能力形状见 subagent-fork-in-process/src/index.ts:61-62）。
  // 成员判定 = childId ∈ root 会话 team/member 事件登记的 member.id 集合；childId 存在本身不是判据。
  // teammate / 普通 subagent / fork / workflow 的本地 in-process 路径一律适用；
  // 外部 provider（acp / codex / claude-code / dsh-sdk）capabilities.agentOptions === false，原样放行，
  // 不按名字特判、也不改它们的路由。命中即严格覆盖 provider/model 并删掉继承来的 reasoningEffort
  // （child-agent.ts:117 只在调用方未显式给 reasoningEffort 时才清继承值），其余 agentOptions 字段
  // （maxTokens 等）与返回值/异常原样透传；入参 spec 不被就地改写。
  // 会话读不到（commandState 抛 TypeError）或 getProvider 抛错一律 fail-open：不注入、不抛，warn 一次避免逐次刷屏。
  let warnedRoute = false
  const warnRoute = (detail) => {
    if (warnedRoute) return
    warnedRoute = true
    ctx.logger?.warn?.(`[force-subagent] ${detail}，子代理模型路由未注入。`)
  }

  /**
   * 模型覆盖可观测性（覆盖优先不变：resolveRoute 的判定口径一行未动）。
   * 触发条件：注入的 provider/model ≠ gateSession 的当前模型选择。留痕两条：
   * 1) ctx.logger.warn 一条，含 session id、会话模型、注入模型、命中的 workspace key 与覆盖来源；
   * 2) 一条 [team-gate] MODEL_OVERRIDE 提醒，复用软门禁既有通道 remindOnce（agent.inject + notice）。
   * 去重口径：WeakMap<会话对象, Set<kind + 注入路由>> —— 同一「会话 + 注入路由」只留痕一次，
   * 与 memberReadFailures / remindedKeys 的 WeakMap 口径一致（随会话回收，无容量上限）。
   * fail-open：本函数内部消化全部异常成一次 warn（不抛给 startActivation、不取消注入）；
   * 读不到会话当前模型时不比较也不告警——判定不了就不告警，与 provider 不可查询时的既有口径一致。
   */
  const overrideReports = new WeakMap()
  let warnedOverrideRead = false
  let overrideLoggerFailures = 0
  /**
   * 留痕专用的告警出口：告警本身不得成为异常来源。宿主 logger 自己抛错时按仓库既有的 sink 兜底口径
   * （见 applyRuntimeLimit 的 console.error 兜底，index.js:776）只兜底一次，并计数，
   * 让「告警通道坏了」这件事本身可见，而不是被空 catch 吞掉。
   */
  const overrideWarn = (detail) => {
    try {
      ctx.logger?.warn?.(`[force-subagent] ${detail}`)
    } catch (error) {
      overrideLoggerFailures += 1
      if (overrideLoggerFailures === 1) {
        console.error(`[force-subagent] 模型覆盖留痕的告警通道失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const warnOverrideRead = (detail) => {
    if (warnedOverrideRead) return
    warnedOverrideRead = true
    overrideWarn(`${detail}，本次模型覆盖留痕跳过（注入照常执行）。`)
  }
  const KIND_LABEL = { member: '成员', subagent: '子代理' }
  const kindLabel = (kind) => KIND_LABEL[kind] ?? String(kind)

  const observeRouteOverride = (agent, gateSession, kind, workspaceKey, route, scopedHit) => {
    try {
      if (gateSession === null || typeof gateSession !== 'object') return
      if (typeof route?.provider !== 'string' || typeof route?.model !== 'string') return
      const sessionModel = sessionModelSelection(ctx, gateSession, (error) => {
        warnOverrideRead(`读取会话 ${sessionIdOf(gateSession) ?? '（id 不可读）'} 的当前模型失败：${error instanceof Error ? error.message : String(error)}`)
      })
      if (sessionModel === undefined) return
      if (sessionModel.provider === route.provider && sessionModel.model === route.model) return
      const routeKey = `${kind}|${route.provider}/${route.model}`
      let seen = overrideReports.get(gateSession)
      if (seen === undefined) {
        seen = new Set()
        overrideReports.set(gateSession, seen)
      }
      if (seen.has(routeKey)) return
      seen.add(routeKey)
      const sessionId = sessionIdOf(gateSession) ?? '（会话 id 不可读）'
      const source = scopedHit
        ? `工作区 ${workspaceKey} 的 ${kind} 条目覆盖`
        : workspaceKey === undefined
          ? '未命中任何 workspace key，取全局路由'
          : `workspace key ${workspaceKey} 无 ${kind} 条目，取全局路由`
      overrideWarn(
        `模型覆盖留痕：session=${sessionId} 会话模型=${sessionModel.provider}/${sessionModel.model} → 注入模型=${route.provider}/${route.model}（${kindLabel(kind)}；来源：${source}）`,
      )
      remindOnce(agent, `model-override:${routeKey}`,
        `[team-gate] MODEL_OVERRIDE: ${kindLabel(kind)}模型被覆盖——会话 ${sessionId} 的当前模型是 ${sessionModel.provider}/${sessionModel.model}，本次实际注入 ${route.provider}/${route.model}（来源：${source}）。覆盖优先仍然生效，本条只是留痕；要换回会话模型，改的是 dsh-force-subagent 的 ${kind} 路由或对应 workspaces 条目，不是 /using-agent-team。`)
    } catch (error) {
      warnOverrideRead(`模型覆盖留痕评估失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const installTeamMemberRoute = (subagents) => {
    const original = subagents?.startActivation
    if (typeof original !== 'function') return
    if (original[ROUTE_WRAPPED] === true) {
      // 已包裹：重复 apply / 重复加载不叠加。按次告警（每次 apply 一次，非每次调用），
      // 否则静默跳过会让「为何不生效」无从排查。
      ctx.logger?.warn?.('[force-subagent] 子代理路由包裹已安装，跳过重复 apply。')
      return
    }
    const wrapped = function startActivation(spec) {
      // 每次激活实时读一次配置：设置文档写入不触发插件热重载，apply 时的快照会过期。
      const live = resolveConfig(liveConfig(ctx, config), configWarn)
      if (live.enabled === false) return original.call(this, spec)
      let nextSpec = spec
      const request = spec?.request
      if (request !== undefined) {
        try {
          // 父会话可能是 teammate（它自己没有 /using-agent-team 记录）：与门禁分支同源，
          // 先解析 membership 拿团队 root 会话，否则 teammate 派生的子代理会漏注入。
          const parentMembership = resolveMembership(ctx, request.parent)
          const gateSession = parentMembership?.root?.session ?? request.parent?.session
          if (commandState(gateSession).enabled) {
            // 能力判定只认公开访问器返回的 provider 对象；拿不到（无 getProvider / undefined / 非对象）
            // 就 fail-open 不注入，也不 warn——这不是故障，只是该 provider 未注册或不可查询。
            const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(spec.provider) : undefined
            if (provider !== undefined && provider !== null && typeof provider === 'object'
              && provider.capabilities?.agentOptions === true) {
              // 成员判定（rc.1）：只认 team/member 事件登记的 childId；childId 存在本身不是判据。
              // rc.2 起宿主不再写 team/member，也没有「成员 / 普通子代理」的结构性区别：
              // 开启团队的 root 直接派下的子级就是成员，teammate 再派的下级按 'subagent' 路由。
              const rosterIds = memberIds(gateSession, (error) => {
                ctx.logger?.warn?.(`[force-subagent] 读取会话 team/member 事件失败，本次按「非成员」处理：${error instanceof Error ? error.message : String(error)}`)
              })
              const isMember = typeof spec.childId === 'string' && (rosterIds.size > 0
                ? rosterIds.has(spec.childId)
                : parentMembership?.role === 'lead')
              // 工作区覆盖：workspaceKey 优先取工作区 path，未注册目录用 cwd 本身；拿不到则回退全局。
              const kind = isMember ? 'member' : 'subagent'
              const workspaceKey = workspaceKeyFor(ctx, gateSession)
              const route = resolveRoute(live, workspaceKey, kind)
              const agentOptions = {
                ...(request.agentOptions ?? {}),
                provider: route.provider,
                model: route.model,
              }
              // 显式给了 reasoningEffort 也要删：核心只在「调用方未显式给」时才清继承的推理档位。
              delete agentOptions.reasoningEffort
              // 组装新 spec 而非就地写 request：入参 spec 保持未污染，调用方与并发观察者看到的仍是原值。
              nextSpec = { ...spec, request: { ...request, agentOptions } }
              // 注入已经发生（覆盖优先不变），这里只补留痕：注入模型 ≠ 会话当前模型时 warn + [team-gate] 提醒各一次。
              observeRouteOverride(request.parent, gateSession, kind, workspaceKey, route,
                workspaceKey !== undefined && live.workspaces?.[workspaceKey]?.[kind] !== undefined)
            }
          }
        } catch (error) {
          warnRoute(`子代理路由判定失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return original.call(this, nextSpec)
    }
    wrapped[ROUTE_WRAPPED] = true
    subagents.startActivation = wrapped
    // disposer 必须删掉本插件写入的自有属性，既不回写 original、也不做身份比较：真实 cordis 4.0.5 的
    // subagents 服务是 traceable Proxy，每次读取方法属性都生成新的函数 Proxy（保留 this 绑定），故
    // `subagents.startActivation === wrapped` 恒为 false；回写 original 则会在 Proxy 上留下自有影子属性，
    // 永久遮蔽宿主 prototype 上的新方法（真实 E2E 探针 c6_ownPropertyAfterDispose=true）。
    // delete 移除本插件写入的自有影子属性后，宿主原型方法随之恢复；本插件未写入时 delete 是 no-op。
    ctx.effect(() => () => {
      delete subagents.startActivation
    }, 'force-subagent:team-member-route')
  }
  installTeamMemberRoute(ctx.get('subagents'))

  const systemPrompt = ctx.get('systemPrompt')
  const commands = ctx.get('commands')
  if (!systemPrompt || !commands) {
    ctx.logger?.warn?.(`[force-subagent] 服务未就绪（inject 未生效？）：${!systemPrompt ? 'systemPrompt ' : ''}${!commands ? 'commands' : ''}缺失，提示与命令停用（门禁仍生效）。`)
    return
  }

  try {
    systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: (context) => {
        try {
          const agent = context?.agent
          const session = agent?.session
          if (session === undefined || session === null) return ''
          const membership = agent === undefined ? undefined : resolveMembership(ctx, agent)
          if (membership?.role === 'teammate') {
            const rootSession = membership.root.session
            return promptText(commandState(rootSession), modeFor() === 'flat' ? MEMBER_NUDGE_FLAT : MEMBER_NUDGE)
          }
          return promptText(commandState(session), modeFor() === 'flat' ? LEAD_NUDGE + FLAT_LEAD_APPENDIX : LEAD_NUDGE)
        } catch (error) {
          ctx.logger?.warn?.(`[force-subagent] 读取会话事件失败，本次不注入 Agent-Team 提示：${error instanceof Error ? error.message : String(error)}`)
          return ''
        }
      },
    })
  } catch (error) {
    if (!(error instanceof Error) || !/already registered/.test(error.message)) throw error
    ctx.logger?.warn?.(`[force-subagent] systemPrompt section "${SECTION_NAME}" 已存在（同一插件只允许挂载一次：检查 profile 是否同时存在 bundle 自挂载与手工 insert）。本次跳过 section 注册，命令仍会注册。`)
  }

  /** 命令 handler：会话页一行结果 + 一条模型可见 notice（带 task 走 steer，其余走 inject）。 */
  const handleCommand = (invocation) => {
    const state = parseCommandInput(invocation?.rawInput)
    deliver(
      invocation?.agent,
      state.enabled && state.task !== undefined ? 'steer' : 'inject',
      buildNotice(state),
      (detail) => ctx.logger?.warn?.(`[force-subagent] ${detail}，命令仍返回成功。`),
    )
    return { kind: 'success', text: resultText(state) }
  }

  try {
    commands.register({
      name: COMMAND_NAME,
      description: '为本会话启用 Agent-Team 强制委派提示，可下达任务，持久到 /using-agent-team off。',
      input: { hint: '<task> | on | off' },
      handler: handleCommand,
    })
  } catch (error) {
    if (!(error instanceof Error) || !/already registered/.test(error.message)) throw error
    ctx.logger?.warn?.(`[force-subagent] 命令 "${COMMAND_NAME}" 已被另一个插件注册（很可能是旧版 dsh-plugin-subagent-director）。修复：将 dsh-plugin-subagent-director 升级到已删除该命令的版本后重启宿主；本次跳过命令注册，systemPrompt 提示仍然生效。`)
  }

  /** 成员容量命令：不带参数 = 读当前值与来源；带整数 = 经 settings 服务写 subagent 命名空间（宿主持久化 + 即时生效）。 */
  try {
    commands.register({
      name: LIMIT_COMMAND_NAME,
      description: `读取或设置 Agent-Team 成员容量：不带参数读当前值与来源，带整数写入 ${CAPACITY_NS}.${CAPACITY_LIMIT_KEY}（rc.2 的宿主旋钮，由宿主持久化并即时生效）。`,
      input: { hint: `[<1–${MAX_CAPACITY_LIMIT} 的整数>]` },
      handler: async (invocation) => {
        const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
        if (raw === '') {
          const read = readCapacity(ctx)
          if (!read.ok) return { kind: 'error', text: `读取成员容量失败：${read.error}` }
          const depth = read.depth === undefined ? '' : `，嵌套深度上限 ${read.depth}`
          return { kind: 'success', text: `Agent-Team 成员容量：${read.limit}${depth}（来源：${capacitySourceLabel(read.source)}）` }
        }
        const result = await setCapacity(ctx, raw)
        if (!result.ok) return { kind: 'error', text: `设置成员容量失败：${result.error}` }
        return { kind: 'success', text: `Agent-Team 成员容量：${result.limit}（${result.status.message}）` }
      },
    })
  } catch (error) {
    if (!(error instanceof Error) || !/already registered/.test(error.message)) throw error
    ctx.logger?.warn?.(`[force-subagent] 命令 "${LIMIT_COMMAND_NAME}" 已被占用，本次跳过注册：/team-limit 不可用，成员容量仍只能在设置页改 ${CAPACITY_NS} 的 ${CAPACITY_LIMIT_KEY}。`)
  }
}
