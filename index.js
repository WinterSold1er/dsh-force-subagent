/**
 * dsh-force-subagent — 用 /using-agent-team 命令按会话启用 Agent-Team 强制委派提示。
 *
 * 状态不落盘：门控直接派生自宿主已记录的 `command/run` 事件
 * （packages/interaction/commands/src/index.ts:373-378 写入 session 事件日志），
 * 在 systemPrompt.section 的 text(context) 里按会话读取即可，天然隔离、幂等。
 * 成员会话没有自己的 command/run 记录，经 agentTeams.tryMembership 回溯 Lead 会话开关。
 * 命令 handler 返回会话页可见的一行结果，同时投递一条模型可见的 user notice：
 * 带 task 走 agent.steer（空闲起一轮、运行中下一步送达），其余走 agent.inject（不唤醒）。
 * task 随 `command/run` 事件持久在 section 里，直到 `off`。不写任何自定义状态。
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

/** Cordis Config：根 volatile，settings 服务据此暴露可写命名空间（namespace = entry id）。 */
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

// 包裹标记打在包装函数自身（不是原方法）：dispose 后原方法不带标记，二次 apply 才会重新包裹；Symbol.for 让重复加载共用同一标记。
const ROUTE_WRAPPED = Symbol.for('force-subagent.team-member-route')

const COMMAND_NAME = 'using-agent-team'
const SECTION_NAME = 'force-subagent:agent-team'
// director 的 orchestrate section 用 55；57 相邻但不与宿主 SECTION_ORDERS 撞值。
const SECTION_ORDER = 57

const LEAD_NUDGE = '本会话已启用 Agent-Team 强制委派提示（/using-agent-team off 可关闭）。Lead：不要独自实现；先用 team_task_create 建立任务 DAG 并划定互斥 write_scopes，再在单轮内批量 spawn_teammate 拉起成员，然后先推进可做的工作，仅在确实被阻塞时才 wait_agent 一次（同一 turn 不得连续两次），收到结果立即处理；你只做架构、拆解、调度、仲裁与最终验收，细节实现全部派发。'

/** flat 模式追加在 Lead nudge 之后的一节：成员收敛动作 + 宿主无删除成员 API 的事实，防止模型假装删除成员。 */
const FLAT_LEAD_APPENDIX = '\n\n【flat 模式：只用成员，不派子代理】成员自己执行，门禁已封死成员的 subagent / subagent_fork / subagent_role / close_subagent / workflow。你每收到一条成员消息，必须先判定该成员本次任务是否完成：已完成 → 立即 interrupt_agent 中断该成员，并用 team_task_update 关闭对应任务，此后永不再向该成员 send_message、不得复用该成员；未完成 → 继续给该成员派活。注意：宿主没有删除 Team 成员的 API（没有删除工具、没有 TeamService 删除方法，roster 行 append-only，active / failed 是硬终态），软踢出只能做到「interrupt_agent 中断其当前 turn + 不再 send_message 唤醒」，成员记录仍然存在——不要声称或假装删除成员。'

// 成员会话没有自己的 command/run 记录，门控改由 Lead 会话的开关派生（见 text 回调与 tools/pre-execute 监听）。
const MEMBER_NUDGE = '你是 Agent-Team 成员。本会话的 Lead 已启用强制委派提示（/using-agent-team off 可关闭）：除编排类与只读工具（subagent / subagent_fork / subagent_role / close_subagent / workflow / team_task_* / send_message / wait_agent / list_agents / interrupt_agent / job_* / skill / todo_write / read / grep / glob）外，其余工具会被门禁拒绝，必须委派；你只是编排者，加载必需技能后，本轮第一个业务工具调用必须是委派（subagent / subagent_fork / workflow），拆分子任务（写范围互斥）后单轮批量派发并在 team_task_* 看板登记，深度≤2；只有 read、grep、glob 可自己用来校验产物，自己只做拆分、合并与校验；阻塞时 wait_agent 只等一次，同一 turn 不得连续两次，收到结果立即处理。'

/** flat 模式的成员提示词：整段替换 MEMBER_NUDGE。追加式写法会在同一段提示里既要求委派又宣布作废，模型两头都能挑；替换式没有这个矛盾，也更短。 */
const MEMBER_NUDGE_FLAT = '你是 Agent-Team 成员（flat 模式：本团队只用成员、不派子代理）。本会话的 Lead 已启用强制委派提示（/using-agent-team off 可关闭）：subagent / subagent_fork / subagent_role / close_subagent / workflow 已被门禁拒绝，你自己执行分给你的任务——read / grep / glob 取证、write / edit 改代码、bash 跑命令与跑测试都由你完成；用 team_task_* 看板登记进度，完成后用 send_message 把结果交回 Lead，由 Lead 判定完成并 interrupt_agent 收敛你；宿主没有删除 Team 成员的 API，不要声称或假装删除成员。'

/** 开启且带 task 时，section 在 nudge 之后追加持续有效的任务段。 */
const TASK_PREFIX = '\n\n本会话任务（/using-agent-team 下达，持续有效）：'

const ENABLED_REMINDER = '【强制委派提醒】用户通过 /using-agent-team 开启本会话的 Agent-Team 强制委派（持续到 /using-agent-team off）。你是 Lead：只做架构、拆解、调度、仲裁与最终验收；实现与测试必须委派。'
const ENABLED_TASK_REMINDER = (task) => `【强制委派提醒】用户通过 /using-agent-team 开启本会话的 Agent-Team 强制委派，并下达任务（本会话持续有效，/using-agent-team off 关闭）：\n${task}\n你是 Lead：只做架构、拆解、调度、仲裁与最终验收；实现与测试必须用 team_task_* 登记后批量 spawn_teammate 委派。`
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

/** 放行白名单：成员会话默认拒绝一切工具，只有精确命中的编排类与只读工具放行（前缀匹配会放过 mcp__ 委派工具，故不用）。 */
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

const denyReason = (tool) =>
  `Agent-Team 成员禁止直接执行「${tool}」：门禁只放行 subagent / subagent_fork / subagent_role / close_subagent / workflow / team_task_* / send_message / wait_agent / list_agents / interrupt_agent / job_* / skill / todo_write / read / grep / glob。必须用 subagent / subagent_fork / workflow 委派子任务，并在 team_task_* 中登记；自己只做拆分、合并与校验。`

/** flat 模式下封死成员派子代理的工具集：ALLOWED_TOOLS 里的全部委派入口（少了 subagent_role / close_subagent 就会被绕过），其余工具一律由成员自己执行。 */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'subagent_role', 'close_subagent', 'workflow'])

const flatDenyReason = (tool) =>
  `flat 模式：成员自己执行，禁止派子代理——「${tool}」已被门禁拒绝。本团队只用成员：读文件、改代码、跑命令、跑测试由你自己完成，做完后用 send_message 把结果交回 Lead，由 Lead 判定完成并 interrupt_agent 收敛你。`

/**
 * Lead 取证门禁的点名工具：只列「取证动作」（跑命令、读文件、搜内容、列文件），
 * 防的是 Lead 自己下场取证而不是委派；write / edit / 委派与编排类工具一律不在其列。
 */
const EVIDENCE_TOOLS = new Set(['bash', 'read', 'grep', 'glob'])

const leadDenyReason = (tool) =>
  `Lead 会话已启用 force-subagent：本轮必须先调用 team_task_create 登记任务（write_scopes 写明改哪些文件、blocked_by 写明依赖），再执行取证工具「${tool}」。bash/read/grep/glob 属取证动作，由你派发的 subagent 执行；Lead 只做拆分、派发、合并与校验。`

const waitDenyReason = () =>
  'wait_agent 连续调用被拦截：上一次工具调用也是 wait_agent，中间没有任何有效动作。先用 list_agents 与 team_task_list 处理已有结果（已结束的队友、completed/ready 任务），或直接推进任务；本 turn 确需阻塞时只允许等待一次。'

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
  // 降级只 warn 一次：门禁评估发生在每次工具调用上，逐次 warn 会刷屏。warn 必须点名缺失服务与放行后果。
  let warnedFailOpen = false
  const warnFailOpen = (tool, detail) => {
    if (warnedFailOpen) return
    warnedFailOpen = true
    ctx.logger?.warn?.(`[force-subagent] ${detail}，门禁未生效，本次放行「${tool}」。`)
  }
  /** 配置解析告警出口：mode 非法取值经 normalizeMode 全局只 warn 一次。 */
  const configWarn = (detail) => ctx.logger?.warn?.(`[force-subagent] ${detail}`)
  /** 实时 mode：只有全局设置这一个来源（页面也只有一个下拉）。读配置失败沿用现成 fail-open：liveConfig 已 warn-once 回退 apply 快照，返回值只会是 'flat' 或 'nested'。 */
  const modeFor = () => resolveConfig(liveConfig(ctx, config), configWarn).mode

  // 成员硬门禁：不依赖提示词，直接拦在工具执行前，白名单外一律 deny。监听器抛异常会让工具整体失败，故自带 catch 兜底放行。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = exec?.name
    try {
      const agent = exec?.agent
      if (agent === undefined) return next()
      const agentTeams = ctx.get('agentTeams')
      if (typeof agentTeams?.tryMembership !== 'function') {
        warnFailOpen(tool, "服务 agentTeams 缺失（ctx.get('agentTeams') 未给出 tryMembership）")
        return next()
      }
      const membership = agentTeams.tryMembership(agent)
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
              // （packages/core/agent-loop/src/tool-calls.ts:168→170），不排除就会每次命中自己、全部 deny。
              const currentCallId = exec?.callId
              let lastCall
              for (let index = turnEvents.length - 1; index >= 0; index -= 1) {
                const turnEvent = turnEvents[index]
                if (turnEvent?.type !== 'tool/call') continue
                if (currentCallId !== undefined && turnEvent?.data?.callId === currentCallId) continue
                lastCall = turnEvent
                break
              }
              if (lastCall?.data?.name === 'wait_agent') return { kind: 'deny', reason: waitDenyReason() }
            }
          }
        }
      }
      // Lead 自身也有 membership（role==='lead'），只拦 teammate；subagent 无 membership → undefined。
      if (membership?.role === 'teammate') {
        // flat 模式：成员自己执行，只封死派子代理这条路；白名单不再限制成员的其余工具。
        if (modeFor() === 'flat') {
          if (DELEGATION_TOOLS.has(tool) && enabledIn(membership.root?.session)) {
            return { kind: 'deny', reason: flatDenyReason(tool) }
          }
          return next()
        }
        // nested 模式（默认）：白名单短路只对成员生效——read / grep / glob 同时在 ALLOWED_TOOLS，若提前放行会绕过下面的 Lead 取证门禁。
        if (isAllowedTool(tool)) return next()
        // 开关取 Lead（root）会话：成员会话没有自己的 command/run 记录。
        if (enabledIn(membership.root?.session)) {
          return { kind: 'deny', reason: denyReason(tool) }
        }
      }
      // Lead 取证门禁：补上成员门禁管不到的另一半——Lead 自己跑 bash / read / grep / glob 取证，
      // 而不是 team_task_create 拆分后派 subagent 去取证。判定口径：会话已开启命令，且「本轮」
      // （事件里最后一个 turn/start 之后）还没有 tool/call(team_task_create)，就 deny 取证工具。
      // 拿不到判定依据（无 session / 事件读不到 / 找不到 turn/start / 读取抛错）一律 fail-open：
      // 门禁自身不可靠时放行工具调用，只 warn 一次，避免把宿主卡死或刷屏。
      if (membership?.role !== 'teammate' && EVIDENCE_TOOLS.has(tool)) {
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
        const registered = events.slice(turnStart + 1).some(
          (event) => event?.type === 'tool/call' && event?.data?.name === 'team_task_create',
        )
        if (registered) return next()
        return { kind: 'deny', reason: leadDenyReason(tool) }
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
          const parentMembership = ctx.get('agentTeams')?.tryMembership?.(request.parent)
          const gateSession = parentMembership?.root?.session ?? request.parent?.session
          if (commandState(gateSession).enabled) {
            // 能力判定只认公开访问器返回的 provider 对象；拿不到（无 getProvider / undefined / 非对象）
            // 就 fail-open 不注入，也不 warn——这不是故障，只是该 provider 未注册或不可查询。
            const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(spec.provider) : undefined
            if (provider !== undefined && provider !== null && typeof provider === 'object'
              && provider.capabilities?.agentOptions === true) {
              // 成员判定只认 team/member 事件登记的 childId；childId 存在本身不是判据。
              // request.parent 是 Agent，.session 才是会话；gateSession 优先取团队 root 会话。
              const isMember = typeof spec.childId === 'string' && memberIds(gateSession, (error) => {
                ctx.logger?.warn?.(`[force-subagent] 读取会话 team/member 事件失败，本次按「非成员」处理：${error instanceof Error ? error.message : String(error)}`)
              }).has(spec.childId)
              // 工作区覆盖：workspaceKey 优先取工作区 path，未注册目录用 cwd 本身；拿不到则回退全局。
              const route = resolveRoute(live, workspaceKeyFor(ctx, gateSession), isMember ? 'member' : 'subagent')
              const agentOptions = {
                ...(request.agentOptions ?? {}),
                provider: route.provider,
                model: route.model,
              }
              // 显式给了 reasoningEffort 也要删：核心只在「调用方未显式给」时才清继承的推理档位。
              delete agentOptions.reasoningEffort
              // 组装新 spec 而非就地写 request：入参 spec 保持未污染，调用方与并发观察者看到的仍是原值。
              nextSpec = { ...spec, request: { ...request, agentOptions } }
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
          const membership = agent === undefined ? undefined : ctx.get('agentTeams')?.tryMembership?.(agent)
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
}
