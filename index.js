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
 * 插件在任何判据下都不返回拒绝结果。监控面 = 「除编排动作（subagent / send_message / wait_agent / todo_write 等）以外的
 * 全部工具」：实现 / 取证 / 执行 / mcp__* 等未枚举工具都按「Lead 亲自下场」处理，每个 turn 首次投递一条提醒并照常放行；
 * read / grep / glob 仅在本 turn 已派发成员后视为「校验产物」而豁免。去重令牌是最后一个 turn/start 的下标，
 * 同一个 turn 只提醒一次，新的 turn 开始后重新提醒——「派发过一次」不再构成整轮豁免。
 * 注入文案与门禁分类都从本步真实工具面派生（systemPrompt 的 context.toolSet / tools/pre-execute 的 exec.toolSet +
 * ctx.tools.definitions(scope, toolSet)），探测不到时降级为标准档文案并 warn 一次，绝不静态断言工具存在。
 */

import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

export const name = 'force-subagent'

/**
 * 注入 `tools` 是为了按本步 toolSet 探测真实工具面（见 apply 里的 capabilitiesFor）：
 * 探测不到时走标准档安全默认，不抛异常。宿主服务名为 `tools`
 * （packages/boot/plugin-manager/src/tools.ts:81、packages/core/agent-tool-presentation/src/index.ts:19）。
 */
export const inject = ['commands', 'systemPrompt', 'subagents', 'tools']

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

/**
 * 可选路由（审查代码模型）：与 routeSchema 的区别是「两段都留空 = 未配置」。
 * 默认值是空串而不是 DEFAULT_ROUTE，是为了让「没配 reviewer」在服务端保持 undefined，
 * 从而回退到 member / subagent 路由；默认值填 DEFAULT_ROUTE 会让每次激活都强制覆盖。
 */
const optionalRouteSchema = () => Schema.object({
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
})

const workspaceSchema = () => Schema.object({
  member: routeSchema().default({ ...DEFAULT_ROUTE }),
  subagent: routeSchema().default({ ...DEFAULT_ROUTE }),
  reviewer: optionalRouteSchema().default({ provider: '', model: '' }),
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
  reviewer: optionalRouteSchema().default({ provider: '', model: '' }),
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

/**
 * 半残可选路由只告警一次：同一处配置在每次实时解析里都会重新归一化，逐次 warn 会刷屏。
 * 去重键是「配置位置」，所以全局 reviewer 与某个 workspaces 条目的 reviewer 各算一次。
 * warn-once 的确切语义：模块级 Set、每进程只提醒一次 —— 同一个配置位置在本进程内第一次半残才告警，
 * 之后无论重新解析多少次（含配置改好后再次半残）都不再重复告警；它不是「每次加载 / 每次解析都提醒」。
 * 跨进程（重启或热重载后重新 apply 插件、模块重新求值）才会重新计数。
 */
const warnedReviewerConfig = new Set()

/**
 * 可选路由归一化：provider 与 model 都是非空字符串才算「配置了」。
 * - 两段都空 / 缺失 / 非法 → undefined：不挂字段，配置结果仍与 DEFAULT_CONFIG 深相等，
 *   审查代码的激活因此回退 member / subagent 路由（面板「留空则回退」的口径）。
 * - 只配了一半（只有 provider 或只有 model）→ 忽略整条路由并 warn-once：
 *   半残配置注入出去就是「provider 配了、模型却是继承值」这种最难排查的错位，绝不注入残缺路由。
 */
function optionalRoute(value, location, warn) {
  const candidate = unwrapVolatile(value)
  const fields = candidate !== null && typeof candidate === 'object' ? candidate : {}
  const provider = typeof fields.provider === 'string' && fields.provider.length > 0 ? fields.provider : ''
  const model = typeof fields.model === 'string' && fields.model.length > 0 ? fields.model : ''
  if (provider.length === 0 && model.length === 0) return undefined
  if (provider.length === 0 || model.length === 0) {
    if (!warnedReviewerConfig.has(location)) {
      warnedReviewerConfig.add(location)
      warn?.(`可选路由 ${location} 只配置了一半（provider=${provider === '' ? '空' : JSON.stringify(provider)}、model=${model === '' ? '空' : JSON.stringify(model)}），整条已忽略，审查代码的激活回退 member / subagent 路由。`)
    }
    return undefined
  }
  return { provider, model }
}

/** 配置深合并：缺省/非法值回退默认，workspaces 逐项规范化，永不抛。warn 可选，用于 mode 非法取值与半残 reviewer 路由（均 warn-once）。 */
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
      const normalized = {
        member: route(item.member, DEFAULT_CONFIG.member),
        subagent: route(item.subagent, DEFAULT_CONFIG.subagent),
      }
      // 工作区 reviewer 同样是可选的：未配就不挂字段，让 resolveRoute 回退全局 reviewer 或 member / subagent。
      const scopedReviewer = optionalRoute(item.reviewer, `workspaces[${JSON.stringify(key)}].reviewer`, warn)
      if (scopedReviewer !== undefined) normalized.reviewer = scopedReviewer
      workspaces[key] = normalized
    }
  }
  const resolved = {
    enabled: typeof root.enabled === 'boolean' ? root.enabled : DEFAULT_CONFIG.enabled,
    mode,
    member: route(root.member, DEFAULT_CONFIG.member),
    subagent: route(root.subagent, DEFAULT_CONFIG.subagent),
    workspaces,
  }
  // reviewer 未配置时不挂字段：DEFAULT_CONFIG 里没有这个键，resolveConfig({}) 必须仍与它深相等。
  const reviewer = optionalRoute(root.reviewer, 'reviewer', warn)
  if (reviewer !== undefined) resolved.reviewer = reviewer
  return resolved
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

/**
 * 路由解析：工作区覆盖优先，否则回退全局同类路由。
 * member / subagent 一定存在（resolveConfig 逐项补默认），所以这两类永远返回一个完整路由。
 * reviewer 是可选路由：工作区条目没有 → 全局 reviewer；全局也没有 → undefined，
 * 由调用方回退 baseKind（member / subagent）路由。判定口径对三类完全一致，不分叉。
 */
export function resolveRoute(settings, key, kind) {
  if (settings === undefined || settings === null) return undefined
  const scoped = key !== undefined && settings.workspaces !== undefined ? settings.workspaces[key] : undefined
  if (scoped !== undefined && scoped !== null && scoped[kind] !== undefined) return scoped[kind]
  return settings[kind]
}

/**
 * 审查代码激活的识别（reviewer 路由的判据）。三段判定，从严到宽，绝不因文案里出现「审查」二字就误判：
 * 1) 显式给了 name：只认名字本身（reviewer / reviewer-1 / code-reviewer / adversarial-reviewer /
 *    review / code-review / code-review-1）。给了非 reviewer 的名字就是明确的命名意图，
 *    即使 label 写着「实现审查代码模型」也不改判 —— 名字优先，且 name 不可命中时绝不回落到 label。
 * 2) 没有 name 时看 request.agentPreset（宿主 preset id 与成员名同一套语法）。
 * 3) 都没有（未命名 subagent / workflow）才看 label，且只认「这条 label 本身就是一条审查指令」的写法：
 *    判定必须锚定在 label 开头（只容忍前置空白与 please 礼貌前缀），审查词组之后紧跟结尾或分隔符。
 *    禁止在 label 的任意位置做子串匹配：「修复 code review 面板的崩溃」「实现 code review 能力」
 *    「给 code-review 加个按钮」「修复 code review 的 bug」里的 code review 是待处理的对象，
 *    不是这条任务自身的意图。误判代价不对称 —— 假阳性会把实现类任务送进「审查代码模型」（有害），
 *    假阴性只是回退到该激活原本的 member / subagent 路由（安全）。
 *    所以本判据严格优先，宁可漏判，绝不因文案里某处出现 code review 就认定审查任务。
 */
const REVIEWER_NAME_RE = /^(?:[a-z0-9-]+-)?reviewer(?:-\d+)?$|^(?:code-)?review(?:-\d+)?$/
// label 判据锚定在开头：^\s*(?:please\s+)? 只容忍前置空白与礼貌前缀，不是放宽子串匹配。
// 旧版另有一条非锚定的 REVIEWER_LABEL_PHRASE_RE（/\bcode[\s_-]+review(?:er)?\b/，任意位置子串匹配），
// 它把实现类 label 误判成审查任务，已删除；锚定的 code…review 词组由本条覆盖。
// 裸 review / reviewing 不得带任意宾语：宾语是可选的时「review 需求文档」「review the docs」
// 「review 配置迁移」也会命中，与本判据「宁可漏判」的口径不符。故要么整条 label 到此结束，
// 要么紧跟冒号或左括号且其后只有「数字」轮次编号并到此结束（词族 round|pass|iter|iteration|轮|第|批|次
// + 可选空白 + 可选 # + 必需数字，或裸 #?数字：review: round 2 / review (2) 命中；
// review: round two / review: 3rd / review: 第 2 轮 / review: 批次 7 / review: round 2 附加说明 不命中），要么后接明确的代码审查宾语
// （可带冠词 the/this/that/a/an + code|diff|pr|changes|impl…|patch|commit|pull request）。
const REVIEWER_LABEL_RE = /^\s*(?:please\s+)?(?:code[\s_-]*review(?:er)?|review(?:ing)?\s+(?:the\s+|this\s+|that\s+|a\s+|an\s+)?(?:code|diff|pr|changes|impl\w*|patch|commit|pull request)|review(?:ing)?(?:[ \t]*$|[ \t]*[:：(（][ \t]*(?:(?:round|pass|iter|iteration|轮|第|批|次)[ \t]*#?\d+|#?\d+)[)）]?[ \t]*$)|代码审查|审查代码|对抗审查|代码评审|评审代码)(?:$|[\s:：\-—(（])/i

const normalizedName = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

/**
 * @param spec - 宿主 SubagentActivationSpec（rc.2 扁平形状：name? / label / provider 同在顶层）。
 * @param request - 与 spec 同源或它的 request 包装；只用其中的 agentPreset 作为身份线索。
 * @returns 是否应按 reviewer 路由注入模型。
 */
export function isReviewerActivation(spec, request) {
  const name = normalizedName(spec?.name)
  if (name !== '') return REVIEWER_NAME_RE.test(name)

  const preset = normalizedName(request?.agentPreset)
  if (preset !== '' && REVIEWER_NAME_RE.test(preset)) return true

  const label = typeof spec?.label === 'string' ? spec.label.trim() : ''
  if (label === '') return false
  // 未命名激活把 reviewer 直接写在 label 里（宿主允许 label 就是成员名）时同样算审查任务；
  // 仍然只认整条 label 就是一个 reviewer 名字，不做子串匹配。
  // 两条判据都必须锚定：任何一条都不许退化成「label 里某处出现 code review」。
  return REVIEWER_LABEL_RE.test(label) || REVIEWER_NAME_RE.test(label.toLowerCase())
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
 * 成员名 → 成员 id 的统一解析：已完成成员门禁的两个寻址口（send_message 的 agent、team_task_update 的 owner）共用。
 * 先看看板事件登记过的名字表（rc.1 的 team/member，roster.ts:42-53）；rc.2 不再写 team/member，
 * 名字是模型侧的，宿主自己经 subagents.resolveName 解析成 Session id（roster.ts），门禁按同一口径解析一次。
 * 两条路都拿不到就返回 undefined：按「判不了就不提醒」的既有 fail-open 口径放行，不 warn。
 */
async function memberByName(name, idsByName, ctx, agent, signal) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  const registered = idsByName.get(name)
  if (registered !== undefined) return registered
  const subagents = ctx.get('subagents')
  if (typeof subagents?.resolveName !== 'function') return undefined
  try {
    return String(await subagents.resolveName(agent, name, signal))
  } catch (error) {
    // 名字解析不了（树里没有这个名字）就不是判定对象：按「判不了就不提醒」的既有口径放行，不 warn。
    void error
    return undefined
  }
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

// ── 工具面能力探测与分档文案（R1/R2）──────────────────────────────────────────────────────────
// 旧实现的根因：nudge 静态写死 team_task_create / 旧 spawn 工具名 / interrupt_agent 等名字，rc.2 里其中
// 若干不存在或默认关闭 → 模型拿到无法执行的指令，只好自己干。现在所有文案都由「本会话真实工具面」派生。

/**
 * 探测用的工具名标记：只在这里写死 rc.2 的真实注册名，其它地方一律先探测再引用。
 * - subagent / subagent_fork：tool-subagent 按加载期 toolName 注册（默认 `subagent`，
 *   packages/subagent/tool-subagent/src/index.ts:49-52），Web/Desktop 预设同时提供 `subagent_fork`
 *   （docs/tool-catalog.md:45）；
 * - send_message / list_agents / wait_agent / interrupt_agent：
 *   packages/subagent/tool-subagent-control/src/{index,list-agents,wait-agent}.ts，
 *   interrupt_agent 受配置层 `interrupt: false` 控制（内置配置已关闭，docs/tool-catalog.md:46）；
 * - todo_write：packages/todo/tool-todo/src/index.ts:137；workflow：docs/tool-catalog.md:2705；
 * - team_task_*：packages/team/tool-agent-team/src/index.ts:118-234，每个工具都带 `{ when: enabled(agent) }`，
 *   **必须带本步 toolSet 探测**（packages/core/tools/src/index.ts:239-241：省略 toolSet 只读注册期可见集合），
 *   否则 Team 开关 OFF 时会把 team_task_* 判成存在——这是本任务最容易踩的假阳性。
 */
const TOOL_MARKERS = Object.freeze({
  board: 'team_task_create',
  boardList: 'team_task_list',
  interrupt: 'interrupt_agent',
  subagent: 'subagent',
  fork: 'subagent_fork',
  send: 'send_message',
  list: 'list_agents',
  wait: 'wait_agent',
  todo: 'todo_write',
  workflow: 'workflow',
})

/**
 * 探测失败时的安全默认（standard 档）：只承诺 rc.2 稳定存在的委派名词。
 * 刻意不承诺 team_task_*（需要 Team 开关）、rc.1 的旧 spawn 工具（rc.2 已删除）——这两类正是旧文案把模型逼去自己干活的根因。
 * 能力字段是三态：true = 探测到确实存在，false = 探测到确实不存在，undefined = 未确认。
 * 未确认只能写中性表述，绝不做「本会话没有这个工具」的否定断言，也不点名它。
 * interrupt 留 undefined：interrupt_agent 默认注册、但可被配置关掉
 * （packages/subagent/tool-subagent-control/src/index.ts:30 的 `interrupt` 默认 true、:118-120 关成 false 时不注册），
 * 探测失败时无从确知，所以既不承诺、也不否定。
 */
const STANDARD_CAPABILITIES = Object.freeze({
  probed: false,
  board: false,
  interrupt: undefined,
  subagent: true,
  fork: true,
  send: true,
  list: true,
  wait: true,
  todo: true,
  workflow: true,
})

/** 工具名集合 → 能力快照（只记录文案与门禁真正会用到的能力）。 */
const capabilitiesFromNames = (names) => ({
  probed: true,
  board: names.has(TOOL_MARKERS.board),
  interrupt: names.has(TOOL_MARKERS.interrupt),
  subagent: names.has(TOOL_MARKERS.subagent),
  fork: names.has(TOOL_MARKERS.fork),
  send: names.has(TOOL_MARKERS.send),
  list: names.has(TOOL_MARKERS.list),
  wait: names.has(TOOL_MARKERS.wait),
  todo: names.has(TOOL_MARKERS.todo),
  workflow: names.has(TOOL_MARKERS.workflow),
})

/**
 * 文案档位（R2）：
 * - team：team_task_create 真实可见 → 保留看板式流程；
 * - standard：没有看板但有 subagent / subagent_fork → todo_write 任务板 + 派成员；
 * - none：连 subagent 都探测不到 → 直说「没有委派能力，直接执行」，不静默，也不教不存在的工具。
 */
const delegationTier = (caps) => (caps.board ? 'team' : caps.subagent || caps.fork ? 'standard' : 'none')

/** 「拆解 + 登记」的写法：只写当前档位真实存在的工具名。 */
const planningHint = (caps) => (delegationTier(caps) === 'team'
  ? '先用 team_task_create 把工作拆成互不依赖的小任务（blocked_by 只写真实依赖、write_scopes 互斥）并登记看板'
  : caps.todo
    ? '先把工作拆成互不依赖的小任务（写范围互斥、依赖只写真实依赖），用 todo_write 登记任务板'
    : '先把工作拆成互不依赖的小任务（写范围互斥、依赖只写真实依赖），并把各自的写范围写进派发说明')

/** 能力三态 → 工具名：只有确认存在（true）才点名；未确认（undefined）与确认没有（false）都不点名。 */
const knownTool = (caps, key) => (caps[key] === true ? TOOL_MARKERS[key] : '')

/** 本会话真实存在的委派动词串（传入的 key 里真实存在的那些），一个都没有就是空串。 */
const dispatchTools = (caps, ...keys) => keys.map((key) => knownTool(caps, key)).filter((tool) => tool !== '').join(' / ')

/** 「再派一个新成员」的写法：动词只取真实存在的派发动词，都没有就不点名。 */
const relaunchPhrase = (caps) => { const verb = dispatchTools(caps, 'subagent', 'fork').split(' / ')[0]; return verb === '' ? '再派一个新成员' : `再 ${verb} 派一个新成员` }

/** 批量拉齐成员的写法：同上，只点名真实存在的派发动词。 */
const launchPhrase = (caps) => { const verb = dispatchTools(caps, 'subagent', 'fork').split(' / ')[0]; return verb === '' ? '一次并行拉起全部成员' : `并行 ${verb} 一次拉起全部成员` }

/** 「不再唤醒已完成成员」的写法：探测到 send_message 才点名它，否则只说纪律。 */
const wakePhrase = (caps) => (caps.send === true ? `向它 ${TOOL_MARKERS.send} 唤醒` : '唤醒它')

/** 等待纪律的写法：探测到 wait_agent 才点名它；确认没有就说没有；未确认只讲纪律、不点名、不否定。 */
const waitAdvice = (caps) => (caps.wait === true
  ? `仅在确实被阻塞时才 ${TOOL_MARKERS.wait} 一次（同一 turn 不得连续两次）`
  : caps.wait === false ? '本会话没有等待成员结果的工具：阻塞时先推进可做的工作'
    : '阻塞时最多等一次，同一 turn 不得连续两次')

/** 「派发」的写法：只写本档真实存在的委派工具名；fork 只在探测到 subagent_fork 时才出现。 */
const dispatchHint = (caps) => {
  const launch = knownTool(caps, 'subagent') || knownTool(caps, 'fork')
  const inherit = caps.subagent === true && caps.fork === true ? `（需要继承本会话上下文用 ${TOOL_MARKERS.fork}）` : ''
  const track = caps.list === true ? `用 ${TOOL_MARKERS.list} 记下成员名` : '记下每个成员的名字'
  return `再在单轮内并行 ${launch} 拉起全部初始成员${inherit}，${track}，不要串行建一个等一个`
}

/**
 * Lead 提醒里的门禁规则：明确「派发过也不整轮豁免」，并给出只含真实工具名的出路。
 * 不枚举取证 / 实现工具名——被点名的工具由提醒正文按当次真实调用给出。
 */
const leadGateSentence = (caps) => `【Lead 委派提醒，每轮都会生效】你自己动取证 / 实现 / 执行类工具（含 mcp__* 等插件工具）时，无论本轮是否已经派发成员，每个 turn 首次都会收到一条前缀 [team-gate] 的提醒，工具照常执行；只有 read / grep / glob 在本轮已派发后视为校验、不再提醒。正确做法：${planningHint(caps)}，${dispatchHint(caps)}。收到新消息开新一轮后同一判据会再提醒一次。`

/** Lead nudge；关闭强制委派时由 promptText 返回空串。 */
const leadNudge = (caps) => {
  if (delegationTier(caps) === 'none') {
    return '本会话已启用 Agent-Team 强制委派提示（/using-agent-team off 可关闭），但本会话没有探测到委派工具（subagent / subagent_fork 都不可用）：没有委派能力，直接执行任务即可，不要声称已派发成员，也不要调用不存在的委派工具。若宿主本应提供委派能力，检查 subagent 服务是否加载与派发深度上限（maxDepth）；门禁只做提醒、不阻断任何工具调用。'
  }
  const parts = ['本会话已启用 Agent-Team 强制委派提示（/using-agent-team off 可关闭）。Lead：不要独自实现；']
  parts.push(`${planningHint(caps)}，`)
  parts.push(`${dispatchHint(caps)}；`)
  parts.push('审查代码的成员 / 子代理建议命名为 reviewer（如 name: "reviewer"）。')
  parts.push(`然后先推进可做的工作，${waitAdvice(caps)}，收到结果立即处理；你只做架构、拆解、调度、仲裁与最终验收，细节实现全部派发。`)
  if (caps.send === true) parts.push(`派活与追问统一用 ${TOOL_MARKERS.send}({ agent: 成员名, message: 内容 })。`)
  parts.push(caps.list === true
    ? `${TOOL_MARKERS.list} 不带参数（rc.2 签名）。`
    : caps.list === false
      ? '本会话没有列出成员的工具，按派发时宿主返回的成员名寻址成员。'
      : '本会话是否提供列出成员的工具未确认，按派发时宿主返回的成员名寻址成员。')
  parts.push(caps.interrupt === true
    ? `成员完成后可用 ${TOOL_MARKERS.interrupt} 收敛；宿主不提供删除成员的入口，不要声称删除成员。`
    : caps.interrupt === false
      ? `成员交回结果后不再${wakePhrase(caps)}、不复活已完成成员；${relaunchPhrase(caps)}承接新活。本会话没有中断成员的工具，不要声称中断或删除成员。`
      : `成员交回结果后不再${wakePhrase(caps)}、不复活已完成成员；${relaunchPhrase(caps)}承接新活。本会话是否提供中断成员的工具未确认，不要声称中断或删除成员。`)
  parts.push(leadGateSentence(caps))
  return parts.join('')
}

/** flat 模式追加在 Lead nudge 之后的一节：成员收敛动作 + 宿主无删除成员 API 的事实。 */
const flatLeadAppendix = (caps) => {
  if (delegationTier(caps) === 'none') return ''
  const verbs = dispatchTools(caps, 'subagent', 'fork', 'workflow')
  const addressHint = caps.list === true ? `${TOOL_MARKERS.list} 不带参数；` : ''
  const parts = ['\n\n【flat 模式：只用成员，不派子代理】成员就是你在委派树里直接派出的成员，每个成员自己执行分到的任务；成员再调 ' + verbs + ' 会被门禁放行但立即提醒。']
  if (caps.send === true) parts.push(`${addressHint}用 ${TOOL_MARKERS.send}({ agent: 成员名, message: 内容 }) 给成员派活，同一个成员名持续可寻址。`)
  parts.push(`你每收到一条成员消息，先判定该成员本次任务是否完成：已完成 → 不再${wakePhrase(caps)}、不复用该成员，需要新活就${relaunchPhrase(caps)}；未完成 → 继续给它派活。`)
  parts.push(caps.interrupt === true
    ? '已完成成员可用 interrupt_agent 中断其当前 turn。'
    : caps.interrupt === false
      ? '本会话没有中断成员的工具：成员完成后你只能不再唤醒它，不要声称中断或删除成员。'
      : '本会话是否提供中断成员的工具未确认：成员完成后你只能不再唤醒它，不要声称中断或删除成员。')
  parts.push('宿主没有删除成员的 API（没有删除工具），委派记录仍然存在——不要声称或假装删除成员。')
  parts.push(`构建团队时把工作拆成互不依赖的小任务（写范围互斥、依赖只写真实依赖），在单轮内${launchPhrase(caps)}，不要串行建一个等一个。`)
  parts.push('flat 不放宽 Lead 门禁：门禁规则与 nudge 正文相同，成员自己执行工具不受该提醒约束。')
  return parts.join('')
}

/** 成员 nudge：flat 整段替换（成员自己执行），nested 让成员继续派子代理；两档都只提真实工具。 */
const memberNudge = (caps, mode) => {
  const dispatchedBy = knownTool(caps, 'subagent') || knownTool(caps, 'fork')
  const head = caps.probed
    ? `你是 Agent-Team 成员（rc.2：你就是 Lead 直接派出的一个成员${dispatchedBy === '' ? '' : `（由 ${dispatchedBy} 派出）`}，${caps.list === true ? `靠 ${TOOL_MARKERS.list} 给出的 agent 名` : '靠 Lead 派发时记下的成员名'}被寻址）。`
    : '你是 Agent-Team 成员（本会话委派工具面未能探测，按 rc.2 标准工具面说明）。'
  if (delegationTier(caps) === 'none') {
    return `${head}本会话没有探测到委派工具（subagent / subagent_fork 都不可用）：直接执行分给你的任务即可（read / grep / glob 取证、write / edit 改代码、bash 跑命令与跑测试都由你完成），完成后${caps.send === true ? `用 ${TOOL_MARKERS.send} ` : ''}把结果交回 Lead。`
  }
  const board = caps.board ? 'team_task_*' : caps.todo ? 'todo_write' : ''
  if (mode === 'flat') {
    const verbs = dispatchTools(caps, 'subagent', 'fork', 'workflow')
    const parts = [`${head}flat 模式：本团队只用成员、不派子代理；${verbs} 会被门禁放行但立即提醒，你自己执行分给你的任务——read / grep / glob 取证、write / edit 改代码、bash 跑命令与跑测试都由你完成。`]
    if (board) parts.push(`用 ${board} 登记进度；`)
    parts.push(caps.send === true ? `完成后用 ${TOOL_MARKERS.send}({ agent: 成员名, message: 结果 }) 把结果交回 Lead，由 Lead 判定完成。` : '完成后把结果交回 Lead，由 Lead 判定完成。')
    parts.push(caps.interrupt === true ? `Lead 可能用 ${TOOL_MARKERS.interrupt} 收敛你。` : '宿主没有删除成员的 API，不要声称或假装删除成员。')
    parts.push(`你所在团队的构建方式：Lead 把工作拆成互不依赖的小任务并在单轮内${launchPhrase(caps)}，所以你只管自己这一小块，做完立即交回，不要等其它成员。`)
    return parts.join('')
  }
  const orchestration = [dispatchTools(caps, 'subagent', 'fork', 'workflow'), board, knownTool(caps, 'send'), knownTool(caps, 'wait'), knownTool(caps, 'list'), knownTool(caps, 'interrupt')]
    .filter((entry) => entry !== '').join(' / ')
  const parts = [`${head}本会话的 Lead 已启用强制委派提示（/using-agent-team off 可关闭）：除编排类与只读工具（${orchestration} / job_* / skill / read / grep / glob）外，其余工具会被门禁放行但立即提醒，仍必须委派；你只是编排者，加载必需技能后，本轮第一个业务工具调用必须是委派，拆分子任务（写范围互斥）后单轮批量派发`]
  parts.push(board ? `并在 ${board} 登记；` : '；')
  parts.push(`宿主对委派深度有硬上限（subagent 服务的 maxDepth），派不出就是它太小，回报 Lead 调整而不是自己硬撑；只有 read、grep、glob 可自己用来校验产物，自己只做拆分、合并与校验；${waitAdvice(caps)}，收到结果立即处理。`)
  return parts.join('')
}

/** 开启且带 task 时，section 在 nudge 之后追加持续有效的任务段。 */
const TASK_PREFIX = '\n\n本会话任务（/using-agent-team 下达，持续有效）：'

/**
 * 命令 notice 也按档分文案：none 档的 section 已经说「没有委派能力、直接执行」，
 * notice 再命令「实现与测试必须委派」就是同一轮里两条互相打架的指令。
 * 档位只取自探测成功的快照（caps.probed === true）：
 * - 一条都没探过（命令是本会话第一个动作，section 与门禁都还没跑）或探测失败只拿到安全默认 → 中性句：
 *   既不承诺「能委派 / 必须委派」，也不断言「没有委派工具」，把能力判断让给同轮随后装配的 section，
 *   同轮两条指令因此不可能互相矛盾；
 * - 探测成功才按 none / 非 none 分档：none 才否定，非 none 才要求委派。
 */
const leadClause = (caps) => (caps === undefined || caps.probed !== true
  ? '本会话已开启 Agent-Team 强制委派提示；本会话的真实工具面尚未确认，是否具备委派能力以本轮系统提示的 Agent-Team 段为准。'
  : delegationTier(caps) === 'none'
    ? '但本会话未检测到委派工具，强制委派提示不生效：没有委派能力，直接执行任务即可，不要声称已派发成员（本会话真实工具面见系统提示的 Agent-Team 段）。'
    : '你是 Lead：只做架构、拆解、调度、仲裁与最终验收；实现与测试必须委派（本会话真实可用的委派工具见系统提示的 Agent-Team 段）。')

const ENABLED_REMINDER = (caps) => `【强制委派提醒】用户通过 /using-agent-team 开启本会话的 Agent-Team 强制委派（持续到 /using-agent-team off）。${leadClause(caps)}`
const ENABLED_TASK_REMINDER = (task, caps) => `【强制委派提醒】用户通过 /using-agent-team 开启本会话的 Agent-Team 强制委派，并下达任务（本会话持续有效，/using-agent-team off 关闭）：\n${task}\n${leadClause(caps)}`
const DISABLED_REMINDER = '【强制委派提醒已关闭】用户执行 /using-agent-team off：本会话不再强制委派，按普通方式处理。'

const reminderText = (state, caps) =>
  !state.enabled ? DISABLED_REMINDER
    : state.task === undefined ? ENABLED_REMINDER(caps)
      : ENABLED_TASK_REMINDER(state.task, caps)

const summaryText = (state) =>
  !state.enabled ? '已关闭强制委派'
    : state.task === undefined ? '已开启强制委派'
      : `已开启强制委派：${state.task.slice(0, 40)}`

const resultText = (state) =>
  !state.enabled ? '已关闭 Agent-Team 强制委派提醒。'
    : state.task === undefined ? '已开启 Agent-Team 强制委派提醒。用 /using-agent-team off 关闭。'
      : '已开启 Agent-Team 强制委派，任务已转交给模型。用 /using-agent-team off 关闭。'

/** 模型可见提醒消息（UserMessage 形态）：宿主 UI 按 source.kind/form 归类为 notice。caps 是本会话最近一次能力快照，notice 按它分档。 */
function buildNotice(state, caps) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: reminderText(state, caps) }],
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

/**
 * 编排动作：只放行「派发 / 调度 / 看板 / 提问」这类不直接干活的工具，Lead 与成员调用都不提醒。
 * 只列 rc.2 真实存在的名字（rc.1 的成员生命周期工具在 rc.2 已不存在，不再列）。
 * team_task_* 的可用性由探测结果决定（见 isOrchestrationTool），不在静态集合里无条件放行。
 */
const ORCHESTRATION_TOOLS = new Set([
  'subagent',
  'subagent_fork',
  'workflow',
  'send_message',
  'wait_agent',
  'list_agents',
  'interrupt_agent',
  'todo_write',
  'ask_user_question',
  'skill',
])

/** 只读校验工具（设计 §3.1「有条件豁免」）：本轮已派发成员后，Lead 用它们校验产物不再提醒。 */
const VALIDATION_TOOLS = new Set(['read', 'grep', 'glob'])

/** job_* 是后台任务的读/杀，属于编排簿记：按前缀识别，避免每个版本逐个维护名字。 */
const isJobTool = (name) => typeof name === 'string' && name.startsWith('job_')

/**
 * 编排动作判定：静态编排集合 + job_* + 看板工具（team_task_*）。
 * 看板工具的两种放行口径：探测到 team_task_create（rc.2 Team 开关 ON）→ 放行；
 * 探测失败（caps.probed === false，rc.1 或诊断上下文）→ 也放行，宁可少提醒一次，避免把真实看板调用误判成「下场干活」。
 */
const isOrchestrationTool = (name, caps) => typeof name === 'string'
  && (ORCHESTRATION_TOOLS.has(name)
    || isJobTool(name)
    || (name.startsWith('team_task_') && (caps.board || !caps.probed)))

/** 成员侧额外收紧：向用户提问是 Lead 的职责，成员直接 ask_user_question 仍按越界提醒（保持既有成员门禁口径）。 */
const MEMBER_DISALLOWED_TOOLS = new Set(['ask_user_question'])

/** nested 模式成员的白名单：编排动作 + 只读校验；其余工具提醒一次后照常执行（插件不拒绝任何成员工具）。 */
const isAllowedTool = (name, caps) => (isOrchestrationTool(name, caps) && !MEMBER_DISALLOWED_TOOLS.has(name))
  || VALIDATION_TOOLS.has(name)

/** 成员越界的软提醒（nested）：工具已放行，文案直接给出只含真实工具名的正确做法。 */
const memberGateReminder = (caps, tool) => {
  const way = `用 subagent${caps.fork ? ' / subagent_fork' : ''}${caps.workflow ? ' / workflow' : ''} 委派子任务${caps.board ? '并在 team_task_* 登记' : caps.todo ? '并用 todo_write 登记' : ''}`
  return `[team-gate] 提醒：Agent-Team 成员不该直接执行「${tool}」——本次已放行，但 nested 模式的正确做法是${way}；自己只做拆分、合并与校验。`
}

/** flat 模式下封死成员派子代理的工具集：只列 rc.2 真实存在的委派入口。 */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow'])

/** flat 模式成员试图派子代理的软提醒：放行 + 点名 flat 模式的正确动作。 */
const flatGateReminder = (caps, tool) => `[team-gate] 提醒：flat 模式只用成员，成员不派子代理——「${tool}」本次已放行，但它不是成员的动作：读文件、改代码、跑命令、跑测试一律由你自己执行，做完后用 send_message({ agent: 成员名, message: 结果 }) 把结果交回 Lead${caps.interrupt ? '，由 Lead 判定完成并 interrupt_agent 收敛你' : '，由 Lead 判定完成'}。`

/**
 * Lead 取证提醒的点名工具：只列「取证 / 执行动作」（跑命令、读文件、读图片、搜内容、列文件、抓网页、搜网页），
 * 针对的是 Lead 自己下场取证而不是委派；命中只投递提醒，工具照常执行。
 * 旁路补齐：`read_image` 是真实的取证入口（读文件类的图片版），宿主注册名见
 * packages/fs/tool-fs/src/read-image.ts:211；`pwsh` 是 bash 的 PowerShell 等价物（同一执行能力，注册名见
 * packages/shell/tool-pwsh/src/index.ts:385）。持久化 pwsh（packages/shell/tool-pwsh-persistent/src/index.ts:428）
 * 注册的模型可见工具名同样是 `pwsh`，与 tool-pwsh 共用同一个名字，因此一条 'pwsh' 同时覆盖前台与持久化两条路。
 * 已知未覆盖：MCP 工具（模型可见名为 `mcp__<server>__<tool>`，由服务器自行决定、逐名点名不可行）不进本集合，
 * MCP 工具（模型可见名为 `mcp__<server>__<tool>`，逐名点名不可行）与其它未枚举工具不再依赖本集合：
 *   门禁改为「凡不在编排动作集合内即提醒」，未知工具一律按硬接管处理（见 isOrchestrationTool）。
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

/** 「本轮已经派发过成员」的判据：本 turn 内出现过委派类 tool/call（只认 rc.2 真实存在的委派入口）。 */
const DISPATCH_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow'])

/** 被点名工具在提醒文案里的归类名：实现类 / 执行类 / 取证类 / 其它（含 mcp__* 等未知工具）。 */
const leadGateToolCategory = (tool) => {
  if (IMPLEMENTATION_TOOLS.has(tool)) return '实现工具'
  if (EXECUTION_TOOLS.has(tool)) return '执行工具'
  if (EVIDENCE_TOOLS.has(tool)) return '取证工具'
  return '工具'
}

/**
 * Lead 亲自下场时的提醒正文：两态（本轮未派发 / 本轮已派发），都只提探测到的真实工具名。
 * 第三种（探测不到任何委派工具）直说没有委派能力、直接执行——不教不存在的工具，也不静默。
 */
const leadGateReminder = (caps, tool, dispatched) => {
  const category = leadGateToolCategory(tool)
  if (delegationTier(caps) === 'none') {
    return `[team-gate] 提醒：本会话没有探测到委派工具（subagent / subagent_fork 都不可用），无法派发成员，${category}「${tool}」由你直接执行。本次调用已放行；本 turn 只提醒一次。若宿主本应提供委派能力，请检查 subagent 服务与派发深度上限（maxDepth）。`
  }
  if (dispatched) {
    return `[team-gate] 提醒：本轮已派发成员，但你仍在亲自执行${category}「${tool}」——派发不等于放手：实现与执行必须由成员完成，Lead 只做拆分、派发、合并与校验。本次调用已放行；本 turn 只提醒一次，新的 turn 开始后会再提醒一次。`
  }
  return `[team-gate] 提醒：本轮还没有派发成员，${category}「${tool}」仍会照常执行。正确做法：${planningHint(caps)}，${dispatchHint(caps)}；Lead 只做拆分、派发、合并与校验。本次调用已放行；本 turn 只提醒一次，新的 turn 开始后会再提醒一次。`
}

/** wait_agent 空转提醒：点名当前真实存在的处理入口（看板 / 任务板）。 */
const waitGateReminder = (caps) => {
  const board = caps.board ? 'team_task_list' : caps.todo ? 'todo_write 的任务状态' : '已有结果'
  return `[team-gate] 提醒：连续两次 wait_agent 之间没有任何有效动作，本次等待已放行，但同一 turn 只允许等待一次。先用 list_agents 与 ${board} 处理已有结果（已结束的队友、已完成任务），或直接推进任务。`
}

/** 已完成成员门禁的软提醒：interrupt_agent 不可用时不得再写软踢出流程。前缀保持不变，供测试断言。 */
const finishedMemberReminder = (caps, subject) => `[team-gate] TEAM_MEMBER_FINISHED: ${subject} 已被判定为「已完成任务」——其名下任务全部处于 completed / deleted。本次调用已放行，但已完成成员不能再承接新任务：${caps.interrupt ? '宿主没有删除成员的 API，interrupt_agent 也只中断 turn 不删记录，成员在委派记录里仍然存在。' : '宿主没有删除成员的 API，成员在委派记录里仍然存在。'}正确做法是${relaunchPhrase(caps)}承接${caps.board ? '，并给它建新的 team_task' : ''}；不要继续向该成员 send_message，也不要把任务 claim / reassign 给它。`

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

/**
 * ── 内置 skills 注册 ─────────────────────────────────────────────────────────
 * 本插件包内的 `skills/<name>/SKILL.md` 注册进宿主 `ctx.skills`，协议与宿主打包 provider 同形
 * （宿主先例：superpowers-dsh/lib/index.js:122 与 @deepseek-ai/dsh-skill-filesystem/src/index.ts:135）：
 *   list() 只发现候选（frontmatter 出 name / description，正文留到 get() 才读）；
 *   get() 解析完整定义，并给出 `{ kind: 'directory' }` 的 resourceBase 供正文里的相对引用。
 * 目录位置是包自身的装配事实（由 import.meta.url 推出），不是用户配置。
 * skills 服务缺失时安静降级：内置 skills 是增值能力，不能拿门禁 / 提示主功能去换。
 * 真实的 FS 或解析错误不吞：ENOENT 以外的失败 warn 一次（同一原因只一次，避免每次目录刷新刷屏）。
 */
const SKILLS_PROVIDER_NAME = 'dsh-force-subagent'
/** 打包 provider 的注册优先级：低于本地 bundled root，与宿主打包 provider 同一口径。 */
const PACKAGED_SKILL_RANK = 550
/** prompt 可见的来源桶（不是优先级）。 */
const SKILL_SOURCE = 'custom'
/** 宿主 skill 名语法（packages/skill/skill/src/index.ts:21 SKILL_NAME）；不合法的名字注册表不会接受。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 本包的 skills 目录：`<包目录>/skills`。目录不存在时 list() 就是空集合。 */
export const PACKAGED_SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'skills')
/**
 * 同因只告警一次：目录读失败会在每次 catalog 刷新时重来一遍。
 * warn-once 的确切语义：模块级 Set、每进程一次，去重键是「问题键」（告警文案本身 —— 出问题的目录 /
 * 失败原因）。同一问题在本进程内只提醒一次，之后无论刷新多少次都不再重复告警；不是「每次加载都提醒」。
 * 跨进程（重启或热重载后重新 apply 插件、模块重新求值）才会重新计数。
 */
const warnedSkillIssues = new Set()

/**
 * 解析 SKILL.md 的 YAML frontmatter：只消费宿主会用到的标量（name / description / whenToUse），
 * 其余标量 metadata 原样透传。没有 frontmatter 块返回 null（不是错误，但这条 SKILL.md 不可用）。
 */
export function parseSkillFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const block = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const metadata = {}
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    metadata[match[1]] = value
  }
  return { metadata, body }
}

/** 读一个 skill 目录的 SKILL.md。ENOENT = 该目录没有 SKILL.md（正常情况，安静跳过）；其它失败 warn 一次。 */
async function readSkillFile(skillFile, { signal, onError } = {}) {
  let text
  try {
    text = await readFile(skillFile, { encoding: 'utf8', signal })
  } catch (error) {
    if (error?.code !== 'ENOENT') onError?.(`读取 ${skillFile} 失败，该内置 skill 本次不可用：${errText(error)}`)
    return undefined
  }
  if (signal?.aborted) return undefined
  const parsed = parseSkillFrontmatter(text)
  if (parsed === null) {
    onError?.(`${skillFile} 没有 YAML frontmatter，内置 skill 已跳过（name / description 无从取得）。`)
    return undefined
  }
  return parsed
}

/** frontmatter → 候选 / 定义的核心字段；名字缺省时用目录名（`<name>/SKILL.md` 的既有约定）。 */
function skillFields(parsed, { dirName, skillFile }) {
  const declared = typeof parsed.metadata.name === 'string' ? parsed.metadata.name.trim() : ''
  const skillName = declared !== '' ? declared : dirName
  if (!SKILL_NAME_RE.test(skillName)) {
    return { error: `${skillFile} 的 skill 名 ${JSON.stringify(skillName)} 不符合宿主语法（小写字母 / 数字 / 连字符）` }
  }
  const description = typeof parsed.metadata.description === 'string' ? parsed.metadata.description : ''
  const whenToUse = typeof parsed.metadata.whenToUse === 'string' ? parsed.metadata.whenToUse : undefined
  const metadata = Object.keys(parsed.metadata).length > 0 ? parsed.metadata : undefined
  return {
    fields: {
      name: skillName,
      description,
      ...(whenToUse !== undefined ? { whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      source: SKILL_SOURCE,
      provider: SKILLS_PROVIDER_NAME,
      ...(metadata !== undefined ? { metadata } : {}),
    },
  }
}

/** 扫描 skills 根目录，一个子目录一个候选；正文留到 get() 才读。 */
export async function listPackagedSkillCandidates(skillsRoot, { signal, onError } = {}) {
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch (error) {
    // ENOENT = 本包没有自带 skills 目录：不是故障，安静按空集合处理。
    if (error?.code !== 'ENOENT') onError?.(`读取内置 skills 目录 ${skillsRoot} 失败，内置 skills 本次未启用：${errText(error)}`)
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (signal?.aborted) break
    if (!entry.isDirectory()) continue
    const locator = join(skillsRoot, entry.name)
    const path = join(locator, 'SKILL.md')
    const parsed = await readSkillFile(path, { signal, onError })
    if (parsed === undefined) continue
    const { fields, error } = skillFields(parsed, { dirName: entry.name, skillFile: path })
    if (error !== undefined) {
      onError?.(error)
      continue
    }
    candidates.push({ ...fields, rank: PACKAGED_SKILL_RANK, locator, path })
  }
  return candidates
}

/** 造 provider：宿主 registerProvider 的 create 回调形状（control 由宿主生命周期提供）。 */
export function createPackagedSkillProvider(skillsRoot = PACKAGED_SKILLS_ROOT, onError) {
  return () => ({
    name: SKILLS_PROVIDER_NAME,
    async list(options) {
      return listPackagedSkillCandidates(skillsRoot, { signal: options?.signal, onError })
    },
    async get(candidate, options) {
      const locator = typeof candidate?.locator === 'string' && candidate.locator.length > 0 ? candidate.locator : skillsRoot
      const skillFile = typeof candidate?.path === 'string' && candidate.path.length > 0 ? candidate.path : join(locator, 'SKILL.md')
      const parsed = await readSkillFile(skillFile, { signal: options?.signal, onError })
      if (parsed === undefined) return undefined
      const { fields, error } = skillFields(parsed, { dirName: basename(locator), skillFile })
      if (error !== undefined) {
        onError?.(error)
        return undefined
      }
      return {
        ...fields,
        resourceBase: { kind: 'directory', path: locator },
        path: skillFile,
        content: parsed.body,
      }
    },
  })
}

/** 注册入口：优先延迟注入（inject 缺服务不会让插件不 apply），退化路径直接 ctx.get('skills')。 */
export function installSkillsProvider(ctx, { skillsRoot = PACKAGED_SKILLS_ROOT } = {}) {
  const warnSkills = (detail) => {
    if (warnedSkillIssues.has(detail)) return
    warnedSkillIssues.add(detail)
    ctx?.logger?.warn?.(`[force-subagent] 内置 skills：${detail}`)
  }
  const hasSkills = (skills) => skills !== undefined && skills !== null && typeof skills.registerProvider === 'function'
  const create = createPackagedSkillProvider(skillsRoot, warnSkills)

  if (typeof ctx?.inject === 'function') {
    let providerRegistered = false
    ctx.inject(['skills'], (child) => {
      const skills = child?.skills
      // 服务缺失（headless 组合 / 未装 skill 层的宿主）：安静降级，不抛也不 warn。
      if (!hasSkills(skills)) return
      try {
        // registerProvider 返回注销器：必须挂到这个注入 scope 的 effect 上，插件卸载 / 热重载时
        // 才会把这条 provider 从 skills 服务里摘掉；丢着不管会让重复 apply 叠加同名 provider。
        const dispose = skills.registerProvider(create)
        providerRegistered = true
        if (typeof dispose === 'function' && typeof child?.effect === 'function') {
          child.effect(() => dispose, 'force-subagent:skills provider')
        } else if (typeof dispose === 'function') {
          warnSkills('注入上下文没有 effect 通道，内置 skills provider 无法随插件卸载释放。')
        }
      } catch (error) {
        warnSkills(`provider 注册失败，内置 skills 未启用：${errText(error)}`)
      }
    })
    // registered 只回答「provider 是否确实已经注册进宿主 skills 服务」：注入是延迟的，
    // 服务缺失、注册失败或回调还没轮到执行时一律 false，不得谎报成功。
    return { registered: providerRegistered, via: 'inject' }
  }

  let skills
  try {
    skills = ctx?.get?.('skills')
  } catch (error) {
    warnSkills(`读取 skills 服务失败，内置 skills 未启用：${errText(error)}`)
    return { registered: false, via: 'get' }
  }
  if (!hasSkills(skills)) return { registered: false, via: 'get' }
  try {
    const dispose = skills.registerProvider(create)
    // 退化路径没有注入 scope 托管注销器：交给 ctx.effect，卸载时释放这条 provider。
    if (typeof dispose === 'function' && typeof ctx?.effect === 'function') {
      ctx.effect(() => dispose, 'force-subagent:skills provider')
    }
    return { registered: true, via: 'get' }
  } catch (error) {
    warnSkills(`provider 注册失败，内置 skills 未启用：${errText(error)}`)
    return { registered: false, via: 'get' }
  }
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

  // 内置 skills 与设置页策略同一口径：走延迟注入，不把 'skills' 写进 inject —— 那会让没装 skill 层的
  // 宿主整个插件都不 apply（门禁静默失效）。服务缺失时安静降级，真实读取失败 warn 一次。
  installSkillsProvider(ctx)

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

  /**
   * 工具面探测（R1）：按 rc.2 的 tools 服务派生「本步真实可用工具集」，注入文案与门禁都从它派生，
   * 不再静态断言工具存在。源码依据：
   * - `definitions(scope, toolSet)` 见 packages/core/tools/src/index.ts:305；`get(name, scope, toolSet)`
   *   见同文件 :239-241；
   * - **必须传本步 toolSet**：省略时只读注册期可见集合（同文件 :239-241），而 team_task_* 带
   *   `{ when: enabled(agent) }` 注册（packages/team/tool-agent-team/src/index.ts:118-234），
   *   Team 开关 OFF 时会被误判为可用；
   * - 本步 toolSet 的来源：系统提示装配走 `AssembleContext.toolSet`（模块扩展见
   *   packages/core/tools/src/index.ts:19-23，agent-loop 在 packages/core/agent-loop/src/agent.ts:298-300 注入），
   *   工具执行走 `ToolExecution.toolSet`（packages/core/tools/src/executor.ts:32-37）；
   * - 宿主内置 section 的同一写法见 packages/subagent/tool-subagent-control/src/index.ts:90-105
   *   （`text: ({ agent, scope, toolSet }) => ctx.tools.get(name, scope, toolSet)`）。
   * 降级链（设计 §1.4）：tools 服务缺失 / toolSet 缺失 / definitions 抛错 → 标准档安全默认，
   * 每次 apply 只 warn 一次，绝不抛。
   */
  let warnedToolProbe = false
  const noteToolProbeFallback = (detail) => {
    if (warnedToolProbe) return
    warnedToolProbe = true
    ctx.logger?.warn?.(`[force-subagent] ${detail}，工具面探测降级为标准委派文案（只提 rc.2 稳定存在的委派工具）。`)
  }
  /**
   * 本会话最近一次能力快照（探测成功或降级都算一次快照）。
   * 命令 handler 没有 step toolSet（命令调用不带工具面），notice 只能按最近一次能力快照分文案；
   * 快照没探过或探测失败（probed !== true）时由 leadClause 走中性句，不凭空再探一次、也不凭空造一条 warn。
   */
  let latestCaps
  const rememberCaps = (caps) => { latestCaps = caps; return caps }
  /**
   * toolSet 缺失时的兜底能力：rc.1 没有 step toolSet 概念，用宿主 Team 开关还原「看板是否真实可用」，
   * 避免 rc.1（有 team 工具）被误降级成 standard 文案；rc.2 Team 开关 ON 但没有 toolSet 时同样适用。
   * isEnabled 抛错只走 warn-once，不阻断。
   */
  const fallbackCapabilities = (agent) => {
    try {
      const teamService = typeof ctx.get === 'function' ? ctx.get(AGENT_TEAMS_SERVICE) : undefined
      if (teamService !== undefined && teamService !== null && typeof teamService.isEnabled === 'function'
        && teamService.isEnabled(agent) === true) {
        return Object.freeze({ ...STANDARD_CAPABILITIES, board: true })
      }
    } catch (error) {
      noteToolProbeFallback(`读取 Team 开关失败（${error instanceof Error ? error.message : String(error)}），无法还原看板能力`)
    }
    return STANDARD_CAPABILITIES
  }
  /** 探测结果按 toolSet 对象缓存：同一 step 内多次调用只扫一次；toolSet 随 step 回收，WeakMap 不泄漏。 */
  const capabilitiesCache = new WeakMap()
  const capabilitiesFor = (context) => {
    const toolSet = context?.toolSet
    if (toolSet !== null && typeof toolSet === 'object') {
      const cached = capabilitiesCache.get(toolSet)
      if (cached !== undefined) return rememberCaps(cached)
    }
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    if (tools === undefined || tools === null || typeof tools.definitions !== 'function') {
      noteToolProbeFallback('宿主 tools 服务不可用（无法读取本会话真实工具清单）')
      return rememberCaps(fallbackCapabilities(context?.agent))
    }
    if (toolSet === undefined || toolSet === null) {
      noteToolProbeFallback('当前步 toolSet 缺失（省略 toolSet 会读到注册期可见集合，team_task_* 会假阳性）')
      return rememberCaps(fallbackCapabilities(context?.agent))
    }
    try {
      // scope 就是宿主本步 consult 这个 toolSet 用的键：ResolvedToolSet 由解析它的 agent 持有，
      // view(scope) 只认同一 agent（packages/core/tools/src/index.ts:284-290），
      // 工具执行侧同样用 exec.agent（packages/core/tools/src/pipeline.ts:107 / :127）；
      // 系统提示装配侧宿主直接给出 scope === agent（packages/core/agent/src/dispatch.ts:174-176：assembleContextFor 返回 { agent, scope: agent }）。
      const scope = context?.scope ?? context?.agent
      const names = new Set()
      for (const definition of tools.definitions(scope, toolSet)) {
        if (typeof definition?.name === 'string') names.add(definition.name)
      }
      if (names.size === 0) {
        // 空清单不是「确认本会话没有委派工具」：toolSet 已 dispose、或 scope 与本步解析者不一致时，
        // 宿主 view() 一律返回空 Map（packages/core/tools/src/index.ts:286）。
        // 把它当成 none 档会让文案与门禁反过来劝 Lead 自己干活，而且没有任何 warn 可追查——
        // 按探测失败走安全默认档（Team 开关还原 / 标准委派文案）并 warn 一次。
        noteToolProbeFallback('工具面探测结果为空（toolSet 可能已 dispose，或 scope 与本步解析者不一致）')
        const fallback = fallbackCapabilities(context?.agent)
        // 同一个 toolSet 对象的同一判据不会变（已释放就是已释放），缓存住免得同一 step 反复探测。
        capabilitiesCache.set(toolSet, fallback)
        return rememberCaps(fallback)
      }
      const caps = capabilitiesFromNames(names)
      capabilitiesCache.set(toolSet, caps)
      return rememberCaps(caps)
    } catch (error) {
      noteToolProbeFallback(`工具面探测抛错（${error instanceof Error ? error.message : String(error)}）`)
      const fallback = fallbackCapabilities(context?.agent)
      // 与空结果那一支同理：缓存的是「该 toolSet 的能力快照」，与这次是探测成功还是降级无关；
      // 同一 toolSet 的判据不会变（抛错的宿主实现不会中途变好），免得同一 step 内反复调 definitions 反复抛。
      if (toolSet !== null && typeof toolSet === 'object') capabilitiesCache.set(toolSet, fallback)
      return rememberCaps(fallback)
    }
  }

  // 成员软门禁：不依赖提示词自觉，判定发生在工具执行前，但只放行 + 提醒，不再拦死工具调用。监听器抛异常会让工具整体失败，故自带 catch 兜底放行。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = exec?.name
    try {
      const agent = exec?.agent
      if (agent === undefined) return next()
      // 能力快照（R1）：本批调用所属 step 的真实工具面；探测失败时是标准档安全默认。
      const caps = capabilitiesFor(exec)
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
              // （packages/core/tools/src/batch.ts:157 先 settlement.start，:243-249 才 append('tool/call', { callId: block.id })；pipeline.ts:120 的 exec.callId 与之同源），不排除就会每次命中自己、每次都提醒。
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
                remindOnce(agent, 'wait-spin', waitGateReminder(caps))
                return next()
              }
            }
          }
        }
      }
      // 已完成成员门禁：send_message 复用已完成成员、team_task_update 把任务交给已完成成员，判定后放行并投递一次提醒。
      // 必须排在下面成员门禁之前——send_message / team_task_update 都算编排动作，排后面会被
      // flat 的提前 return 或 nested 白名单放行短路。sender 是谁都拦（Lead 与其它成员同样受拦）。
      const callArgs = exec?.arguments !== null && typeof exec?.arguments === 'object' ? exec.arguments : undefined
      const callAction = typeof callArgs?.action === 'string' ? callArgs.action : undefined
      // 设计 §3.5：standard 档停用本门禁——rc.2 不写 team/member 事件、send_message 用成员名寻址，
      // 没有看板就没有「成员名下任务全部 completed」这个判据；此时纪律由注入文案承担。
      // team 档（有 team_task_create）保留完整判定。
      if (caps.board && (tool === 'send_message' || (tool === 'team_task_update' && (callAction === 'claim' || callAction === 'reassign')))) {
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
              // rc.2 的 send_message 参数是 { agent: 成员名, message }（docs/tool-catalog.md:2313）；
              // 旧的 target / agent_id 寻址已删除，这里只读 agent，不再猜兼容参数。
              const name = typeof callArgs?.agent === 'string' ? callArgs.agent.trim() : ''
              memberId = await memberByName(name, idsByName, ctx, agent, exec.signal)
              subject = name.length > 0 ? `send_message 的目标成员「${name}」` : 'send_message 的目标成员'
            } else if (callAction === 'claim') {
              // 宿主用名字寻址成员，但 claim 的承接者就是调用者本人，成员 id === 其 Agent id（roster.ts:96-98）。
              memberId = agent?.id
              subject = `claim 新任务的成员「${membership?.name ?? agent?.id}」（你自己）`
            } else {
              const name = typeof callArgs?.owner === 'string' ? callArgs.owner.trim() : ''
              // rc.2：看板 owner 与 send_message 的成员名是同一套模型侧寻址，走同一个解析口径。
              memberId = await memberByName(name, idsByName, ctx, agent, exec.signal)
              subject = `team_task_update action=reassign 指定的 owner「${name}」`
            }
            if (memberId !== undefined && finished.has(memberId)) {
              remindOnce(agent, `finished-member:${memberId}`, finishedMemberReminder(caps, subject))
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
            remindOnce(agent, 'flat-delegation', flatGateReminder(caps, tool))
          }
          return next()
        }
        // nested 模式（默认）：编排动作短路只对成员生效——read / grep / glob 属于校验集合，若提前放行会绕过下面的 Lead 取证门禁。
        if (isAllowedTool(tool, caps)) return next()
        // 开关取 Lead（root）会话：成员会话没有自己的 command/run 记录。
        if (enabledIn(membership.root?.session)) {
          remindOnce(agent, 'member-gate', memberGateReminder(caps, tool))
        }
      }
      // Lead 门禁（R3）：监控面 = 「除编排动作以外的全部工具」——不再维护 17 个硬编码工具名，
      // mcp__* / office_* / present 等未枚举工具同样命中（isOrchestrationTool 之外一律按下场处理）。
      // 规则（设计 §3.1 / §3.2）：
      // - 实现 / 执行 / 外部取证 / 未知工具：每个 turn 首次触发一次 [team-gate]，与「本轮是否已派发」无关；
      // - read / grep / glob：仅在本轮已派发成员后视为「校验产物」豁免，未派发时照样提醒；
      // - 已派发成员**不构成整轮豁免**：旧实现「本轮出现过 DISPATCH_TOOLS 就整轮静默」让 Lead 派一次
      //   subagent 换整轮自由（S1），这条已删除；
      // - 提醒始终是 notice（remindOnce → agent.inject + notice 形态），不 deny、不阻断。
      // 去重令牌 = 最后一个 turn/start 在事件序列里的下标：同一轮只提醒一次（两种态共用），跨轮重新提醒。
      // 拿不到判定依据（无 session / 事件读不到 / 找不到 turn/start / 读取抛错）一律 fail-open：
      // 不提醒、放行工具调用，只 warn 一次，避免把宿主卡死或刷屏。
      if (membership?.role !== 'teammate' && !isOrchestrationTool(tool, caps)) {
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
          warnFailOpen(tool, '无法定位会话（exec.agent.session 缺失），无法判定本轮是否已派发成员')
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
          warnFailOpen(tool, '会话事件不可读（readEvents 无返回），无法判定本轮是否已派发成员')
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
        // 派发过只影响 read / grep / glob 的校验豁免，不再是「整轮静默」的开关。
        const dispatched = thisTurn.some((event) => event?.type === 'tool/call' && DISPATCH_TOOLS.has(event?.data?.name))
        if (VALIDATION_TOOLS.has(tool) && dispatched) return next()
        // 轮次令牌 = 最后一个 turn/start 的下标：同轮只提醒一次，跨轮令牌变化后重新提醒一次。
        remindOnce(agent, `lead-evidence:${turnStart}`, leadGateReminder(caps, tool, dispatched))
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
  const KIND_LABEL = { member: '成员', subagent: '子代理', reviewer: '审查代码' }
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
      // 入参形状兼容（0.2.2-rc.2）：SubagentActivationSpec 是**扁平**的——
      // `extends Omit<SubagentStartRequest, 'label' | 'signal'>`（宿主 packages/subagent/subagent/src/types.ts:29），
      // parent / prompt / agentOptions 与 provider / label / delivery / signal 同在顶层，
      // 调用点 tool-subagent/src/index.ts:317-333 也是 `{ provider, label, ...request, signal, delivery }` 展开；
      // 生产 spec 里没有 `request` 包装键。rc.1 与本仓库旧测试用 spec.request 包装。
      // 判据：顶层有 parent 就认顶层（宿主当前消费的形状），否则回落 request 包装；
      // 两者都拿不到 parent 时沿用既有 fail-open：不注入、不抛。
      const nested = spec?.request !== undefined && spec?.parent === undefined
      const request = nested ? spec.request : spec
      if (request !== undefined && request !== null) {
        try {
          const parent = request.parent
          // 父会话可能是 teammate（它自己没有 /using-agent-team 记录）：与门禁分支同源，
          // 先解析 membership 拿团队 root 会话，否则 teammate 派生的子代理会漏注入。
          const parentMembership = resolveMembership(ctx, parent)
          const gateSession = parentMembership?.root?.session ?? parent?.session
          if (commandState(gateSession).enabled) {
            // 能力判定只认公开访问器返回的 provider 对象；拿不到（无 getProvider / undefined / 非对象）
            // 就 fail-open 不注入，也不 warn——这不是故障，只是该 provider 未注册或不可查询。
            const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(spec.provider) : undefined
            if (provider !== undefined && provider !== null && typeof provider === 'object'
              && provider.capabilities?.agentOptions === true) {
              const rosterIds = memberIds(gateSession, (error) => {
                ctx.logger?.warn?.(`[force-subagent] 读取会话 team/member 事件失败，本次按「非成员」处理：${error instanceof Error ? error.message : String(error)}`)
              })
              // 成员判定保持原语义，不得放宽成「全员 member」：
              //  - 带 childId（rc.1 宿主写法，或 rc.2 本地 child 的预留身份 types.ts:41）：优先 team/member 名册，
              //    名册为空才看父是不是 root；
              //  - 不带 childId（rc.2 外部调用恒如此）：只能用 parent 的身份推断——root（Lead）直接派的子级才是
              //    成员，teammate 再派的下级、以及身份解析不出来的父，一律走 'subagent' 路由。
              const isMember = typeof spec.childId === 'string'
                ? (rosterIds.size > 0 ? rosterIds.has(spec.childId) : parentMembership?.role === 'lead')
                : parentMembership?.role === 'lead'
              // 工作区覆盖：workspaceKey 优先取工作区 path，未注册目录用 cwd 本身；拿不到则回退全局。
              const workspaceKey = workspaceKeyFor(ctx, gateSession)
              // reviewer 是第三类路由，只在激活本身被识别为审查代码时参与判定，且优先级链是
              // 工作区 reviewer > 全局 reviewer > 该激活本来的 member / subagent 路由。
              // reviewer 未配置（resolveRoute 返回 undefined）时 kind 与 route 都与改动前完全一致。
              const baseKind = isMember ? 'member' : 'subagent'
              const reviewerRoute = isReviewerActivation(spec, request)
                ? resolveRoute(live, workspaceKey, 'reviewer')
                : undefined
              const kind = reviewerRoute !== undefined ? 'reviewer' : baseKind
              const route = reviewerRoute ?? resolveRoute(live, workspaceKey, baseKind)
              const agentOptions = {
                ...(request.agentOptions ?? {}),
                provider: route.provider,
                model: route.model,
              }
              // 显式给了 reasoningEffort 也要删：核心只在「调用方未显式给」时才清继承的推理档位。
              delete agentOptions.reasoningEffort
              // 注入落点必须是顶层 agentOptions：宿主只读顶层——manager.resolveChildAgentOptions(parent,
              // spec.agentOptions)（packages/subagent/subagent/src/manager.ts:340），写进 request 包装等于没写。
              // 仍组装新 spec 而非就地写：入参 spec 保持未污染，调用方与并发观察者看到的仍是原值。
              nextSpec = { ...spec, agentOptions }
              // rc.1 嵌套形状（spec.request 包装）保留兼容写回：包装内同步更新，宿主消费的仍是顶层。
              if (nested) nextSpec = { ...nextSpec, request: { ...request, agentOptions } }
              // 注入已经发生（覆盖优先不变），这里只补留痕：注入模型 ≠ 会话当前模型时 warn + [team-gate] 提醒各一次。
              observeRouteOverride(parent, gateSession, kind, workspaceKey, route,
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
          // 每次装配按本步 toolSet 重新探测（不冻结）：Team 开关 / preset 变化后下一步自动换档（设计 §3.4）。
          const caps = capabilitiesFor(context)
          const mode = modeFor() === 'flat' ? 'flat' : 'nested'
          const membership = agent === undefined ? undefined : resolveMembership(ctx, agent)
          if (membership?.role === 'teammate') {
            const rootSession = membership.root.session
            return promptText(commandState(rootSession), memberNudge(caps, mode))
          }
          const nudge = leadNudge(caps)
          return promptText(commandState(session), mode === 'flat' ? nudge + flatLeadAppendix(caps) : nudge)
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
      buildNotice(state, latestCaps),
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
