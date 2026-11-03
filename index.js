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

export const name = 'force-subagent'

export const inject = ['commands', 'systemPrompt']

const COMMAND_NAME = 'using-agent-team'
const SECTION_NAME = 'force-subagent:agent-team'
// director 的 orchestrate section 用 55；57 相邻但不与宿主 SECTION_ORDERS 撞值。
const SECTION_ORDER = 57

const LEAD_NUDGE = '本会话已启用 Agent-Team 强制委派提示（/using-agent-team off 可关闭）。Lead：不要独自实现；先用 team_task_create 建立任务 DAG 并划定互斥 write_scopes，再在单轮内批量 spawn_teammate 拉起成员，用 wait_agent 等待；你只做架构、拆解、调度、仲裁与最终验收，细节实现全部派发。'

// 成员会话没有自己的 command/run 记录，门控改由 Lead 会话的开关派生（见 text 回调与 tools/pre-execute 监听）。
const MEMBER_NUDGE = '你是 Agent-Team 成员。本会话的 Lead 已启用强制委派提示（/using-agent-team off 可关闭）：除编排类与只读工具（subagent / subagent_fork / subagent_role / close_subagent / workflow / team_task_* / send_message / wait_agent / list_agents / interrupt_agent / job_* / skill / todo_write / read / grep / glob）外，其余工具会被门禁拒绝，必须委派；你只是编排者，加载必需技能后，本轮第一个业务工具调用必须是委派（subagent / subagent_fork / workflow），拆分子任务（写范围互斥）后单轮批量派发并在 team_task_* 看板登记，深度≤2；只有 read、grep、glob 可自己用来校验产物，自己只做拆分、合并与校验。'

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

/**
 * Lead 取证门禁的点名工具：只列「取证动作」（跑命令、读文件、搜内容、列文件），
 * 防的是 Lead 自己下场取证而不是委派；write / edit / 委派与编排类工具一律不在其列。
 */
const EVIDENCE_TOOLS = new Set(['bash', 'read', 'grep', 'glob'])

const leadDenyReason = (tool) =>
  `Lead 会话已启用 force-subagent：本轮必须先调用 team_task_create 登记任务（write_scopes 写明改哪些文件、blocked_by 写明依赖），再执行取证工具「${tool}」。bash/read/grep/glob 属取证动作，由你派发的 subagent 执行；Lead 只做拆分、派发、合并与校验。`

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

export function apply(ctx) {
  // 降级只 warn 一次：门禁评估发生在每次工具调用上，逐次 warn 会刷屏。warn 必须点名缺失服务与放行后果。
  let warnedFailOpen = false
  const warnFailOpen = (tool, detail) => {
    if (warnedFailOpen) return
    warnedFailOpen = true
    ctx.logger?.warn?.(`[force-subagent] ${detail}，门禁未生效，本次放行「${tool}」。`)
  }

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
      // 白名单短路只对成员生效：read/grep/glob 同时在 ALLOWED_TOOLS，若提前放行会绕过下面的 Lead 取证门禁。
      if (membership?.role === 'teammate' && isAllowedTool(tool)) return next()
      // Lead 自身也有 membership（role==='lead'），只拦 teammate；subagent 无 membership → undefined。
      if (membership?.role === 'teammate' && enabledIn(membership.root?.session)) {
        return { kind: 'deny', reason: denyReason(tool) }
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
            return promptText(commandState(membership.root.session), MEMBER_NUDGE)
          }
          return promptText(commandState(session), LEAD_NUDGE)
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
