# DSH Agent Team 宿主插件 API 契约

面向实现者：写一个 DSH 宿主插件，用 `/using-agent-team` 命令按会话开启**系统提示词 section** 提醒（不是伪造 user 消息）；命令未开启或已 `off` 时不注入，其余时间完全惰性。

**路径缩写**（全文声明一次）：`TREE` = `/home/csy/Code/installer/deepseek-harness-0.2.1-rc.3`；`AT` = `packages/experimental/agent-team/src`；`TAT` = `packages/experimental/tool-agent-team/src`；`SP` = `packages/core/system-prompt/src`。其余 `packages/...`、`vendor/...` 路径均相对 `TREE`。

## 当前实现口径：命令门控的 `systemPrompt.section`

`index.js` 现在声明 `export const inject = ['commands', 'systemPrompt', 'subagents']`，在 `apply` 里注册**一个** section 和一个命令、包裹 `subagents.startActivation` 注入子代理模型路由；不挂 `agent/pre-step`、不追加 user 消息、不写自定义会话事件类型：

```js
export const inject = ['commands', 'systemPrompt', 'subagents']

export function apply(ctx) {
  const systemPrompt = ctx.get('systemPrompt')
  const commands = ctx.get('commands')
  if (!systemPrompt || !commands) { /* logger.warn 点名缺失服务 */ return }  // 插件停用

  systemPrompt.section({
    name: 'force-subagent:agent-team',
    order: 57,
    text: (context) => {
      // 从后往前找最后一条 command/run；args === 'off' 返回 ''，其余返回提醒
    },
  })
  commands.register({ name: 'using-agent-team', /* handler 只返回一行文本 */ })
}
```

六条不变量：

1. **inject 声明依赖**：Cordis 在 `commands`、`systemPrompt` 与 `subagents` 都就绪后才调用 `apply`（`subagents` 是子代理模型路由注入、包裹 `startActivation` 的前提）；`apply` 内 `ctx.get` 是一次性快照，返回空（isolate 场景）时 `ctx.logger.warn` 点名缺失服务并 `return`，插件停用而非静默降级。
2. **状态不落盘**：门控派生自宿主已记录的 `command/run` 事件（`packages/interaction/commands/src/index.ts:373-378`），按会话天然隔离、幂等。
3. **最新命令胜出**：`text` 从事件数组尾部向前找第一条 `command/run` 且 `data.name === 'using-agent-team'`；`args === 'off'` 返回 `''`，裸命令 / `on` / `<task>` 返回提醒，找不到事件返回 `''`。
4. **section 名与顺序固定**：`force-subagent:agent-team`、order 57（与 director 的 `orchestrate-mode`/55 相邻但不撞值）。
5. **同名命令冲突**：`commands.register` 抛 "already registered" 时 `ctx.logger.warn` 点名 `dsh-plugin-subagent-director` 并提示升级/卸载，只跳过命令注册，section 照常工作；其他错误原样抛出。
6. **不伪造消息、不加钩子**：没有 fake user message、没有 `agent/pre-step`、没有自定义 session 事件类型；零依赖。

> 下文关于 `agent/pre-step` 消息级追加与按角色 scoped section 的分析是**历史方案/参考**（保留角色判定、引用相等、投影故障等结论，对任何注入点都成立）；当前 `index.js` 只用全局 `systemPrompt.section`，开关来自宿主 `command/run`，不查 `tryMembership`。

## TL;DR / 结论速览

- 角色判定唯一入口是 `ctx.agentTeams.tryMembership(agent)`：成员返回 `TeamMembership`（`role` 为 `'lead'` 或 `'teammate'`），非成员返回 `undefined`；`role === 'lead'` **不是**"处于 team 模式"的证据，任何没有 subagent descriptor 的 root agent 都走 `AT/roster.ts:112` 的默认分支被认成 lead。
- 必须传实时活着的同一个 `Agent` 对象引用：`AT/roster.ts:90` 用 `this.ctx.agents.get(agent.id) !== agent` 做引用相等校验，传 id 或过期对象会静默退化为 `undefined`。
- `tryMembership` 同步、无 I/O、对调用者不抛错；`membership()` 会抛 `TEAM_NOT_MEMBER`（`AT/roster.ts:76-82`），每轮 assemble 的热路径只能用前者。
- systemPrompt 的 `text` 提供器在每次 assemble 时重新求值、无缓存（`SP/index.ts:658-667`）；当前实现在全局 `ctx.systemPrompt.section` 注册，用 `context.agent.session` 读命令事件（`context.agent` 只作备选）。
- 门禁由 `export const inject = ['commands', 'systemPrompt', 'subagents']` 保证：服务未就绪时 Cordis 不调用 `apply`，`ctx.get` 返回空时插件 warn 并停用；`subagents` 只用于包裹 `startActivation` 注入子代理模型路由；本插件不再依赖 `agentTeams`，开关来自会话内 `command/run` 事件（§6 为历史方案参考）。

## 0. 版本与证据基线

- `dsh` 命令解析到 `/home/csy/Code/installer/deepseek-harness/apps/cli/lib/bin.js`，版本 0.2.1-alpha.4。
- 但当前 GUI（http://127.0.0.1:3080）的宿主进程实际是 `/home/csy/Code/installer/deepseek-harness-0.2.1-rc.3/apps/cli/lib/bin.js web --port 3080`，版本 0.2.1-rc.3。
- 已用 `diff -rq` 确认两棵树的 `packages/experimental/agent-team/src` 与 `packages/experimental/tool-agent-team/src` 完全一致，因此下文的行号对两份安装都成立；文档统一按 rc.3 引用。
- 包名：`@deepseek-ai/dsh-experimental-agent-team`（v0.2.1-rc.3）；工具层 `@deepseek-ai/dsh-experimental-tool-agent-team`。

## 1. `ctx.agentTeams` 服务契约

服务注册与键名：

```
AT/index.ts:36-38
declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
```

`AT/index.ts:76` → `super(ctx, 'agentTeams')`（服务键名字面量就是 `'agentTeams'`）。

服务自身依赖，`AT/index.ts:57`：`static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']`。

公开方法（均以 `Agent` 作为调用者凭据）：

| 方法 | 位置 | 签名 | 说明 |
| --- | --- | --- | --- |
| `membership` | `AT/index.ts:116-118` | `membership(agent: Agent): TeamMembership` | 转发 `this.roster.membership(agent)`；非成员会抛错 |
| `tryMembership` | `AT/index.ts:219-221` | `tryMembership(agent: Agent): TeamMembership \| undefined` | 转发 `this.roster.tryMembership(agent)`；不抛错 |
| `listMembers` | `AT/index.ts:125-127` | `listMembers(agent: Agent): TeamMemberView[]` | 先取 membership 再列 roster |
| `spawnTeammate` | `AT/index.ts:135-137` | `async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>` | |
| `listTasks` | `AT/index.ts:178-180` | `listTasks(caller: Agent): TeamTaskView[]` | 同步 |
| `waitForChange` | `AT/index.ts:199-` | `async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>` | 首行即 `this.roster.membership(caller)` |
| `sendMessage` | `AT/index.ts:223-248`（实现 `sendAdmitted`） | 内部：`private async sendAdmitted(caller, request): Promise<SendTeamMessageResult>` | 见 §4 |

成员身份结构 —— **定义在 roster.ts 而不是 types.ts**，`AT/roster.ts:27-33`：

```ts
/** Caller identity inside one implicit Team. */
export interface TeamMembership {
  readonly root: Agent
  readonly id: TeamId
  readonly role: 'lead' | 'teammate'
  readonly name: string
}
```

四个字段都是必填、无可选。没有独立的 role 类型别名，`'lead' | 'teammate'` 是内联联合（另见 `AT/types.ts:62`、`AT/types.ts:104`）。经 `AT/index.ts:32` 再导出。

注意 `AT/types.ts:59-69` 的 `TeamMemberView` 是 roster 行视图（含 `status`/`diagnostics` 等），**不是** membership，不要混用。

## 2. 角色判定语义（核心）

`membership` 只是 `tryMembership` 的抛错包装，`AT/roster.ts:76-82`：

```ts
membership(agent: Agent): TeamMembership {
  const membership = this.tryMembership(agent)
  if (membership === undefined) {
    throw new TeamError(`agent "${agent.id}" is not a member of an active Agent Team`, 'TEAM_NOT_MEMBER')
  }
  return membership
}
```

`tryMembership` 完整实现，`AT/roster.ts:89-119`：

```ts
tryMembership(agent: Agent): TeamMembership | undefined {
  if (this.ctx.agents.get(agent.id) !== agent) return undefined
  try {
    const parentId = agent.session.header.parentSession
    if (parentId !== undefined) {
      const root = this.ctx.agents.get(parentId)
      if (root !== undefined) {
        const member = this.journal.state(root).members.find(candidate => candidate.id === agent.id)
        if (member?.phase === 'active' || member?.phase === 'provisioning') {
          return { root, id: TeamId(root.id), role: 'teammate', name: member.name }
        }
        if (this.subagentDescriptor(agent)) return undefined   // AT/roster.ts:103
        return { root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' }
      }
    }
    if (this.subagentDescriptor(agent)) return undefined       // AT/roster.ts:111
    return { root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' }  // AT/roster.ts:112
  } catch {
    return undefined
  }
}
```

三种对象的返回值：

| 对象 | 返回 | 依据 |
| --- | --- | --- |
| Agent team 的 root lead（**即使尚未 spawn 任何成员**） | `{ role: 'lead', name: 'lead', root: agent, id: TeamId(agent.id) }` | `AT/roster.ts:112`；判定不依赖 roster 里是否有 teammate，也不依赖是否 spawn 过 |
| 由 `spawnTeammate` 产生的 teammate | `{ role: 'teammate', name: member.name, root: <Lead agent>, id: TeamId(root.id) }` | `AT/roster.ts:96-99`；要求 durable member 的 `phase` 为 `active` 或 `provisioning` |
| 非 team 的普通 subagent | `undefined` | `AT/roster.ts:103` 或 `:111`：只要自己 session 的 suffix 里存在 subagent descriptor 就返回 undefined |

`subagentDescriptor`，`AT/roster.ts:467-471`：

```ts
private subagentDescriptor(agent: Agent): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return foldSubagentDescriptor(agent.session.snapshotEvents(agent.session.inheritedEventCount)) !== undefined
}
```

即：只读该 agent 自己 `inheritedEventCount` 之后的 suffix 事件，折出 `subagent/descriptor` 记录即视为 provider-owned subagent。

关键推论（必须写进文档）：

- `role === 'lead'` **不是**"这个会话是 team 模式"的证据——任何非 subagent-descriptor 的 root agent 都会被认成 `lead`（`AT/roster.ts:112` 是默认分支）。
- 身份校验在 `AT/roster.ts:90`：`this.ctx.agents.get(agent.id) !== agent` 直接 `undefined`。**必须传实时活着的同一个 Agent 对象引用**，传 id 或过期对象会得到 undefined。
- 普通 subagent 被 `:111`/`:103` 先行拦截，所以"非成员不注入"只需判 `tryMembership(...) === undefined`。

## 3. 副作用、抛错与性能

- `tryMembership` **查询不创建团队**。它只读投影：`AT/journal.ts:29-34`

```ts
state(root: Agent): TeamState {
  const projection = this.ctx.sessionProjections.stateOf(root.session, 'agentTeam')
  if (projection === undefined) throw new Error('Agent Teams projection is not registered')
  if (projection.failure !== undefined) throw new Error(projection.failure)
  return projection
}
```

  即：投影未注册或投影失效时 `state()` 会 **throw**，但这些 throw 被 `AT/roster.ts:113-118` 的 `catch { return undefined }` 吞掉。所以 `tryMembership` 对调用者永不抛错（并因此把"投影故障"与"非成员"都归为 undefined —— 这是一个语义损失，见风险）。
- `membership()` 会抛 `TEAM_NOT_MEMBER`。**热路径（每轮 systemPrompt 回调）只能用 `tryMembership`**。
- 调用是**同步**的，无 I/O、无 await、无锁；成本 = 一次 `agents.get` + 一次投影读取 + 小数组 `find`。可以每轮每 assembly 调用。
- 不要在 text 回调里调用 `listMembers`/`listTasks`/`spawnTeammate`（会走 roster/任务板，属于有状态操作）。

## 4. Lead → teammate 消息的投递形态与可挂钩子

投递内容前缀，`AT/index.ts:230-233`：

```ts
const content = [
  { type: 'text' as const, text: `Team message from ${membership.name}:` },
  ...structuredClone(request.content),
]
```

投递路径，`AT/index.ts:237-247`：

```ts
const source = { kind: 'agent-message' as const, form: 'relay' as const, senderSessionId: caller.id }
let messageId
if (target.id === root.id) {
  const input = createUserMessage({ content, source })
  root.steer(input)
  messageId = input.id
} else {
  messageId = await steerHostSubagentPrompt(this.ctx.subagents, root, target.id, content, source, request.signal)
}
```

结论：teammate 收到的是一条 **user 角色**的消息，以 `Team message from <lead name>:` 开头（lead 名为 `'lead'`，见 `AT/roster.ts:112`），经 `steerHostSubagentPrompt` 注入目标 subagent session，并带 `source.kind='agent-message'`、`form='relay'`、`senderSessionId`。

**不存在**"team 消息到达"的专用 cordis 事件。该包内没有为消息投递 emit 事件；可用的生命周期钩子只有 agent 级事件，参考 `TAT/index.ts:423-424`：

```ts
ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
ctx.on('agent/disposed', ({ agent }) => {
```

（历史结论）当时认为"收到 Lead 消息时提醒"无法靠事件实现，只能靠**每轮重新求值的动态 systemPrompt**；`agent/pre-step` 确实存在（每个 step 的决策点给出本次消息批次），一度据此做过消息级追加，但当前实现回到命令门控的 `systemPrompt.section`（见文首「当前实现口径」），消息级追加仅作历史参考。

等价性论证（模板）：

> systemPrompt 的 `text` 提供器在**每次 assemble 时重新求值**（`SP/index.ts:61-66` 明确 "provider evaluated at each assembly"；实现见 `SP/index.ts:658-667`），而 agent-loop 每轮都会 assemble 一次（`packages/core/agent-loop/src/agent.ts:272`），并在回合中刷新 context（`agent.ts:411`）。Lead→teammate 的消息是以 user 角色 steer 进入目标 session 并驱动新一轮的，所以"消息到达"必然伴随一次新的 assemble。=> 每轮动态渲染的提醒，在"每条 Lead 消息之后至少出现一次"这一点上覆盖了"收到消息时提醒"。
>
> 差异（必须诚实写明）：它不保证"同一条消息内只提醒一次"，也不保证提醒出现在消息文本紧邻位置；提醒始终位于 system prompt 而不进入会话历史。若要求严格的"消息到达即触发"语义，需上游新增事件，当前版本不支持。

## 5. systemPrompt 侧如何拿到"当前 Agent"

`AssembleContext` 基础声明只有两个字段，`SP/index.ts:42-50`：

```ts
export interface AssembleContext {
  scope?: ScopeKey
  signal?: AbortSignal
}
```

**但它被 augmentation 扩展了**，`packages/core/agent/src/runtime-types.ts:18-23`：

```ts
declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** Agent for this assembly; absent on diagnostics. When present, `scope` must identify the same agent. */
    agent?: Agent
  }
}
```

并在 agent 派发时填充，`packages/core/agent/src/dispatch.ts:174-176`：

```ts
export function assembleContextFor(agent: Agent, signal?: AbortSignal): AssembleContext {
  return { agent, scope: agent, ...signal === undefined ? {} : { signal } }
}
```

于是有两条可行策略：

- **策略 A（推荐，官方同款）**：注册时闭包捕获 agent，`text` 内用闭包 agent 查 `ctx.agentTeams.tryMembership(agent)`。参考实现 `TAT/index.ts:168-190`：`const scoped = agent.ctx`（:169），`scoped.systemPrompt.section({...})`（:173-177），`scoped.systemPrompt.context({...})`（:178-190），其 `text` 内直接 `ctx.agentTeams.membership(agent)`（:183）——不读 `context.agent`。
- **策略 B**：全局注册一个 section，在 `text(context)` 里读 `context.agent`；必须处理 `undefined`（诊断性 assemble 无 agent），且类型可见性依赖是否引入 `dsh-agent` 的 augmentation。

每次求值：`SP/index.ts:658-667` 在 assemble 里逐条调用 `section.text(context)`；`SP/index.ts:673` + `SP/index.ts:380-383` 处理 context。**没有缓存**。

半回合刷新只刷 context 不刷 section：`SP/index.ts:582-602` 的 `refreshContext` 只重建 `contexts` 并 `return { ...assembly, contexts }`；`PromptContext` 的注释也写明是 "evaluated at assembly and admission refresh"（`SP/index.ts:84`）。=> 若希望提醒在回合中刷新，用 `context`；每轮一次够用则用 `section`。

空文本不会产生空标题：`renderPrompt` 有 `.filter(text => text.length > 0)`（`SP/index.ts:293`），`renderContextSections` 同样（`SP/index.ts:336`）。=> `text` 返回 `''` 是安全的不注入方式。

作用域与继承：`assemble` 用 `this.layers.chainLayers(scope)` 合并 scope 链，"Scoped sections shadow globals before the deterministic order sort"（`SP/index.ts:614-632`）。=> 全局注册的 section 对**所有** agent（含 teammate）生效；`agent.ctx` 上注册的 section 只对该 agent 生效。

## 6. 门禁：如何判定"处于 agent team 模式"（历史方案参考）

- 谁启用 agent team：**profile bundle 层**。`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 明确列有 `@deepseek-ai/dsh-experimental-agent-team-profile`；`dsh --profile web --dump-config` 里由该 bundle 插入三个插件：`agent-team`（`@deepseek-ai/dsh-experimental-agent-team`）、`tool-agent-team`、`ui-agent-team`。
- 该 profile 层同时禁用 subagent 工具：`packages/experimental/agent-team-profile/cordis.patch.yml` 对 `tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork` 设 `disabled: true`；`--dump-config` 复核一致（`tool-subagent`、`tool-subagent-fork` 均 `disabled: true`）。
- 服务存在 = 插件加载的判据，不是"该 agent 是成员"的判据：`inject` 里的服务缺失时 cordis 不进入 ACTIVE，`vendor/cordis/src/fiber.ts:611-617` 的 `_refresh()` 只要任一注入服务缺失就置 `INACTIVE`，`fiber.ts:316-318` 在发布后逐个 `_checkImpl(name)` 再 `_refresh()`。=> 历史方案用 `export const inject = ['agentTeams']` 让插件在无 agent-team 的部署里根本不 apply；当前实现的 inject 是 `['commands', 'systemPrompt', 'subagents']`。
- `TeamService` 本身是**全局单例、无 per-agent 门禁**（`AT/index.ts:56-108`，构造函数即注册服务）。=> 服务存在只说明"部署有 agent team 能力"；某个 agent 是否成员仍必须每轮 `tryMembership` 判定。
- 实测风险：磁盘上的 profile 配置把 `tool-subagent`/`tool-subagent-fork` 置为 `disabled: true`，但当前运行中的会话仍暴露 `subagent`/`subagent_fork` 工具。=> **运行中的 host 早于当前磁盘配置启动**；不得用"配置文件内容"推断运行时行为，一律以运行时服务/结果为准。

## 7. role 判定伪代码

```ts
// 注册阶段（每个 agent 一次）
function install(agent, ctx) {
  const scoped = agent.ctx                                  // TAT/index.ts:169
  const role = () => ctx.agentTeams.tryMembership(agent)    // 同步、不抛错
  return scoped.systemPrompt.section({
    name: 'force-subagent-nudge',                           // 必须全局唯一，重复注册会抛
    order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
    text: () => {
      const m = role()
      if (m === undefined) return ''                        // 非成员：空串 => 被 SP/index.ts:293 过滤
      return m.role === 'lead' ? renderLead() : renderTeammate()
    },
  })
}
// 装载阶段
for (const agent of ctx.agents.list()) maybeInstall(agent)   // TAT/index.ts:422
ctx.on('agent/created', ({ agent }) => maybeInstall(agent))  // TAT/index.ts:423
ctx.on('agent/disposed', ({ agent }) => dispose(agent))      // TAT/index.ts:424
// maybeInstall 内先门禁：
//   if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return   // TAT/index.ts:419
```

注意伪代码里"`text` 内再查一次 role"是有意为之：`text` 每轮求值（`SP/index.ts:658-667`），不能在安装时把 role 缓存成常量；而安装门禁与渲染门禁必须都做——前者避免给非成员注册 section，后者覆盖"agent 在安装后才改变身份/被回收"的窗口。

## 8. 风险清单

> 下列条目源自历史"按角色、per-agent scoped section"方案；其中 section 求值、唯一性、作用域的结论对当前全局 section 同样成立，当前实现不查 `tryMembership`。

1. **不要缓存 role**：`text` 每轮重算（`SP/index.ts:658-667`）；把 `tryMembership` 结果提到安装时求值一次，会让 teammate 在 phase 变更后仍渲染旧文案。
2. **必须用 `tryMembership`**：`membership()` 抛 `TEAM_NOT_MEMBER`（`AT/roster.ts:76-82`），在每次 assemble 的热路径上抛错会污染整个 system prompt 组装。
3. **必须传实时 Agent 引用**：`AT/roster.ts:90` 是引用相等校验；捕获过期引用会静默退化为 undefined（不注入），表现为"提示随机消失"。
4. **投影故障与"非成员"不可区分**：`AT/journal.ts:31-32` 的 throw 被 `AT/roster.ts:113-118` 吞成 `undefined`。若团队投影损坏，历史方案下本插件会静默不注入；这是刻意取舍（不让提醒逻辑否决 agent 生命周期），但排查时需要看 `agentTeams` 自身日志。
5. **section 名必须全局唯一**：重复注册抛错（`SP/index.ts:54`、`SP/index.ts:80` 注释 "a duplicate registration throws"）。同一 agent 重复安装会重复插入，须用 `Map<Agent, dispose>` 去重并按 `agent/disposed` 清理（`TAT/index.ts:417`、`:424-427`）。
6. **全局 vs scoped**：全局 `ctx.systemPrompt.section` 会给所有 agent（含 teammate）加上同一段文字，无法按角色区分；按角色必须用 `agent.ctx`（策略 A）。
7. **工具名兼容**：启用 agent-team-profile 的部署里 `tool-subagent`/`tool-subagent-fork` 被禁用（见 §6），teammate 提示若要求"派发 subagent"会指向不可用工具。文案需按部署能力区分或改用中性措辞。
8. **运行态 ≠ 磁盘配置**：见 §6 末条实测证据；任何"仅某种模式生效"的判断都必须以运行时服务/`tryMembership` 结果为准。

## 9. 未解疑问

1. 未找到"team 消息到达"的事件；当前门控已改为读宿主 `command/run` 事件，若上游后续新增消息级事件（如 `agent/message` 或 team 级事件），可改用事件驱动获得严格的一次性提醒语义。
2. `waitForChange` 等长轮询接口的语义未逐行核实到实现末行（仅确认首行取 membership，`AT/index.ts:199-200`）。
3. `teamPolicy(...)` 在 `TAT/index.ts:176` 是以**值**传入（非函数），推断为静态字符串，未逐行核实其定义。
4. 未做运行时实证：所有结论均为源码静态阅读 + `--dump-config` 输出核对，未在真实会话中断言渲染结果。
5. `AssembleContext.agent` 属于 augmentation 扩展（`runtime-types.ts:18-23`），第三方纯 JS 插件不引入类型也能在运行时读到；但该字段的稳定性依赖上游保留该 augmentation，非公开契约的一部分。

## 10. 子代理路由注入的锚点（`getProvider` / `capabilities` 判别）

`/using-agent-team` 开启时，插件包裹 `ctx.subagents.startActivation`，对**所有能接收子代理 `agentOptions` 的本地 in-process provider** 注入默认路由（`provider = 'dsh-opencode-go'` / `model = 'deepseek-v4.1-flash'`，可由插件 Config 的 `member` / `subagent` 字段分别配置；`enabled: false` 时完全透传）：显式 `provider` / `model` 一律被覆盖，`reasoningEffort` 一律删除，其余 `agentOptions` 字段（`maxTokens` 等）保留。成员判定 = `spec.childId` ∈ 父会话 `team/member` 事件登记的 `member.id` 集合（agent-team 在 `startActivation` 前写入该事件，`member.id` 就是预分配的 `childId`）；`childId` 存在本身不是判据。另两个必要条件是父会话 `/using-agent-team` 已开启，且该次激活所选 provider 的 `capabilities.agentOptions === true`。下列行号在 rc.5 树中核对。

**Config 与两条路由**（`index.js` 的 `export const Config` / `resolveConfig` / `DEFAULT_CONFIG`）：

| Config 字段 | 默认值 | 注入语义 |
| :--- | :--- | :--- |
| `enabled` | `true` | `false` 时包裹直接 `original.call(this, spec)`：原 `spec` 对象原样转发，`agentOptions` 逐字段不变、`reasoningEffort` 不删、不被默认路由覆盖。 |
| `member.provider` / `member.model` | `dsh-opencode-go` / `deepseek-v4.1-flash` | `spec.childId` 命中 `memberIds(gateSession)`（root 会话 `team/member` 事件的 `member.id` 集合）时采用。 |
| `subagent.provider` / `subagent.model` | `dsh-opencode-go` / `deepseek-v4.1-flash` | 其余激活采用：无 `childId`，或带 `childId` 但不在成员集合里。 |

配置优先于调用方显式传参（force 语义）：命中后 `agentOptions` 由 `{ ...request.agentOptions, provider: route.provider, model: route.model }` 组装并 `delete agentOptions.reasoningEffort`——调用方给的 provider/model 一定被覆盖，`maxTokens` 一类字段保留，入参 `spec` 不被就地改写。`resolveConfig` 对缺省与非法值（非字符串、空串、非布尔 `enabled`、非对象路由）逐项回退默认且不抛，返回副本，`DEFAULT_CONFIG` 不会被调用方污染。profile 覆盖写法：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-force-subagent
  config:
    enabled: true
    member: { provider: dsh-opencode-go, model: deepseek-v4.1-flash }
    subagent: { provider: dsh-opencode-go, model: deepseek-v4.1-flash }
```

`Config` 根节点 `.volatile()`，可写命名空间即 entry id `dsh-force-subagent`；注入侧读取的是 `apply(ctx, config)` 时的快照；配置文件/设置页改动由 HMR 触发 dispose + 重新 apply，无需重启，只有插件源码改动需要重启 host。换新的 `model` 必须同时把它加进 `subagent-model-selection-settings.config.allowedModels`，否则核心在 `assertAllowedModelSelection` 抛「not allowed」。

| 锚点 | 语义 |
| :--- | :--- |
| `packages/subagent/subagent/src/index.ts:573-575` | `getProvider(name: string): SubagentProvider \| undefined`——公开访问器，按名查 provider 注册表（`list()` 见 `:581-583`）。插件用它取 `spec.provider` 对应的 provider 对象，再读 `capabilities`，不按 provider 名字硬编码。 |
| `packages/subagent/subagent/src/index.ts:631-651` | `assertCapabilities`：`request.agentOptions !== undefined` 而 `!provider.capabilities.agentOptions` 时抛 `SubagentError(..., 'UNSUPPORTED_CAPABILITY')`（文案 `does not support the "agentOptions" capability`）。这是「外部 provider 不能注入」的核心依据，也是插件判据必须与能力位一致的原因。 |
| `packages/subagent/subagent-fork-in-process/src/index.ts:61-62` | 能力声明形状：`readonly capabilities: SubagentCapabilities = { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true }`。`agentOptions: true` 表示该 provider 接受子代理 `agentOptions`（fork 与 in-process spawn 均如此）。 |
| `packages/subagent/tool-subagent/src/index.ts:172` | 工具层同一判据：`config.agentOptions` 非空而 `!subagentProvider.capabilities.agentOptions` 时直接报 `does not support child agentOptions`。 |
| `AT/roster.ts:264`（`childId` 在 `:266`） | teammate 启动调用 `ctx.subagents.startActivation({ delivery: 'parent', childId, provider, ... })`，并显式 `provider`。成员判定 = `spec.childId` ∈ root 会话 `team/member` 事件登记的 `member.id` 集合；`childId` 存在本身不是判据（普通 `subagent` / `workflow` 不传 `childId`，按子代理路由注入）。 |
| `packages/subagent/subagent/src/manager.ts:390` | `const agentOptions = resolveChildAgentOptions(parent, request.agentOptions, childDepth)`；入参 `spec.provider` 决定由哪个 provider 创建子代理。`request.agentOptions` 是插件注入值进入子代理路由的唯一入口。 |
| `packages/subagent/subagent/src/child-agent.ts:98-116` | 先铺 parent 的 `provider` / `model` / `reasoningEffort` / `maxTokens`（`:108-112`），再展开 `...requested`（`:113`）→ `request.agentOptions` 覆盖 parent 路由。 |
| `child-agent.ts:116-117` | 核心只在「路由确已变更**且**调用方未显式给 `reasoningEffort`」时删继承值。插件显式给了 provider/model，但调用方可能自带 `reasoningEffort`，因此插件侧必须自己删——不能指望核心兜底。 |
| `packages/settings/settings/src/index.ts:302-318`（`documentPath` 见 `:292`） | 可写命名空间怎么来：`describe()` 只列出 ACTIVE 且 `volatileForm(schema)` 非空（`:308`）的 profile entry，`ns` 就是 entry id（`:315`，本插件即 `dsh-force-subagent`）。写侧 `:385-388` 先要求 entry 至少有一个 volatile 字段，再逐路径拒绝非 volatile 字段（`Config field "…" is not volatile`），落盘目标即 `documentPath`（profile 的 `cordis.patch.yml`）。插件 Config 根节点 `.volatile()` 就是为了让 `enabled` / `member` / `subagent` 进入这个可写命名空间。 |

**为什么这是插件侧唯一有效缝**：子代理的 LLM 路由只在 `resolveChildAgentOptions` 里定案，输入只有 `parent` 与 `request`；插件不改 profile、不改 `TeamMembership` / journal，也不伪造 `childId`，只在激活入参上写 `agentOptions`。本插件是默认路由的**唯一**来源，不依赖 `dsh-plugin-subagent-director` 提供任何模型默认值。

**为什么外部 provider 不注入**：`acp` / `codex` / `claude-code` / `dsh-sdk` 的 `capabilities.agentOptions === false`（它们的 `agentOptions` 语义是「合并到自己的实例默认值」，见 `types.ts:163-166`），核心在 `assertCapabilities`（`:631-651`）直接以 `UNSUPPORTED_CAPABILITY` 拒绝带 `agentOptions` 的激活。插件因此原样放行：不注入、不 warn、不猜名字——判据只有能力位。

**失效模式**：会话状态不可读（无 session / 事件读不到 / 读取抛错）或 `getProvider` 抛错时，不注入、不抛、`ctx.logger.warn` 只打一次，命令与 `tools/pre-execute` 门禁不受影响；拿不到 provider（无 `getProvider` / 返回 `undefined` / 非对象）时同样不注入，但**不 warn**——provider 未注册不是插件故障。真实宿主的 `subagents` 服务是 traceable Proxy，每次读方法属性都返回新的函数 Proxy（保留 this 绑定），故 disposer 不做身份比较，而是 `delete` 本插件写在服务对象上的自有影子属性，让宿主 prototype 方法随之恢复（不回写原引用：那会留下自有影子属性永久遮蔽原型新方法）；卸载后再次 `apply` 会重新安装包裹，重复 `apply` 由 Symbol 守卫跳过并 warn 一次。需要随升级复核的口径只有一条：上游若把 `provider` 名换成新注册的 in-process provider，注入是否命中取决于其 `capabilities.agentOptions`，与名字无关。
