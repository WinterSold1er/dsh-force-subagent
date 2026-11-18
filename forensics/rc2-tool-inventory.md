# rc.2 委派工具面取证（`dsh-force-subagent` / Agent Team）

**结论先行**

1. `spawn_teammate` 在 rc.2 已删除（提交 `11479fca13`），替代面 = `subagent` / `subagent_fork` + 统一的 `send_message` + **没有 `scope` 参数**的 `list_agents`。
2. `team_task_*` 在 rc.2 源码里仍在（`packages/team/tool-agent-team`），但**按会话 Team 开关动态可见，默认关闭**；`interrupt_agent` 源码仍在，但内置组合把它显式关闭（`interrupt: false`）。所以「模型工具清单里没有它们」是**配置+门控**的结果，不是源码删除。
3. **section 能拿到当前会话实际可用的工具清单**：`AssembleContext` 是合并可扩展的，section 的 `text(context)` 回调能拿到 `{ agent, scope, modelSelection, toolSet }`，用 `ctx.tools.get(name, scope, toolSet)` / `ctx.tools.definitions(scope, toolSet)` 判定。**修复方案可行**，且宿主自己就用这套写法。

---

## 0. 取证基线

| 项 | 值 |
|---|---|
| checkout | `/home/csy/Code/installer/deepseek-harness-0.2.2-rc.2/` |
| HEAD | `ddac96760b Merge pull request #8277 ... release-dsh-0.2.2-rc.2` |
| 目标 tag | `dsh-v0.2.2-rc.2` |
| 对照 tag | `dsh-v0.2.1-rc.1`（Lead 记忆里的旧版本） |
| 检索方式 | 源码用 `grep -n` / `read` / `git show <tag>:<path>`（vectr 未索引该 checkout） |

> 注意区分两种「存在」：`docs/tool-catalog.md` 是**包能力目录**（包里有这个工具就登记），不等于**shipped 组合**里模型真能看到它。本报告第 1 节最后一列给的是 shipped 可见性。

---

## 1. 工具存在性对照表

| 工具 | 0.2.1-rc.1 证据 | rc.2 源码证据 | rc.2 shipped 可见性 | 结论 |
|---|---|---|---|---|
| `spawn_teammate` | `dsh-v0.2.1-rc.1:packages/experimental/tool-agent-team/src/index.ts:193` | **无任何注册**（`grep -rn "name: 'spawn_teammate'"` 无命中）；仅剩客户端标题残留 `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:122`、`control-details-model.ts:171`，以及 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:5605` 里一段静态 keyDomain 注释 | 不可见 | **已删除** |
| `team_task_create` | `dsh-v0.2.1-rc.1:...experimental/tool-agent-team/src/index.ts:299` | `packages/team/tool-agent-team/src/index.ts:118`，注册条件 `:141 { when: ({agent}) => enabled(agent) }` | 仅 Team 开关 ON 时 | 存在、按会话门控 |
| `team_task_list` | 同上（同文件） | `packages/team/tool-agent-team/src/index.ts:144`，`:182` when | 同上 | 同上 |
| `team_task_get` | 同上 | `packages/team/tool-agent-team/src/index.ts:185`，`:198` when | 同上 | 同上 |
| `team_task_update` | 同上 | `packages/team/tool-agent-team/src/index.ts:201`，`:234` when | 同上 | 同上 |
| `interrupt_agent` | `dsh-v0.2.1-rc.1:...experimental/tool-agent-team/src/index.ts:286` | `packages/subagent/tool-subagent-control/src/index.ts:120`；注册被配置门控 `:40 const interrupt = config.interrupt !== false`、`:118 if (!interrupt) return` | **关闭**：`packages/bundle/base/cordis.patch.yml:386-389`（`interrupt: false`），web-app 三份 preset 同样 `interrupt: false`（`standard.patch.yml:98`、`ptc.patch.yml:95`、`cordis.patch.yml:94`） | 源码在、shipped 关 |
| `list_agents` | `dsh-v0.2.1-rc.1:packages/subagent/tool-subagent-control/src/list-agents.ts:87`（旧版还有 `scope?: ListAgentsScope`，同文件 `:25/:29/:49-51`） | `packages/subagent/tool-subagent-control/src/list-agents.ts:46`，**`parameters: {}` 于 `:56`**（无任何参数） | 无条件可见 | 存在、**无 `scope`** |
| `send_message` | rc.1 有两份：Team 版 `...experimental/tool-agent-team/src/index.ts:222`（`target` 参数 `:225`）+ 通用版 `tool-subagent-control/src/index.ts` | `packages/subagent/tool-subagent-control/src/index.ts:44`；参数只有 `agent`（`:47-56`，另一 Agent 的名字）+ `message`（`:57-61`） | 无条件可见 | 存在、**统一为按名寻址**（不再有 `target`） |
| `wait_agent` | rc.1 Team 版 `:250` | `packages/subagent/tool-subagent-control/src/wait-agent.ts:91`（参数 `timeout_ms`） | 无条件可见 | 存在 |
| `subagent` | rc.1 已在：`dsh-v0.2.1-rc.1:packages/subagent/tool-subagent/src/index.ts:159` `config.toolName ?? 'subagent'` | `packages/subagent/tool-subagent/src/index.ts:162`（默认名）、`:207-208`（`defineTool` + `name: toolName`）、`:338`（注册） | `base/cordis.patch.yml:391-395`（`provider: spawn` / `toolName: subagent`） | 存在 |
| `subagent_fork` | — | 同一个插件第二实例：`base/cordis.patch.yml:401-405`（`provider: fork` / `toolName: subagent_fork`） | 可见 | 存在 |
| `workflow` | rc.1 已在：`dsh-v0.2.1-rc.1:packages/workflow/tool-workflow/src/index.ts:60` 默认名 | `packages/workflow/tool-workflow/src/index.ts:59-60`（`toolName` 默认 `'workflow'`）、`:331-332`（注册） | `base/cordis.patch.yml:415-416` | 存在 |

**本会话实测工具面**（`subagent` / `subagent_fork` / `send_message` / `list_agents` / `wait_agent`）与上表 shipped 列完全吻合：缺的正是「Team 开关门控的 `team_task_*`」与「配置关闭的 `interrupt_agent`」，`spawn_teammate` 则是真删除。

---

## 2. 删除提交与替代方案

`git log --oneline -S 'spawn_teammate' -- packages/` 收敛到两个提交（一个引入、一个删除）：

| 提交 | 日期 | 内容 | tag 归属 |
|---|---|---|---|
| `11479fca13 refactor(team): reuse subagents with id-only addressing` | 2026-10-15 | **删除 `spawn_teammate`**（diff 中 `packages/experimental/tool-agent-team/src/index.ts: -181: name: 'spawn_teammate'`）；Team 成员改由 subagent 运行时创建，寻址改为 id/名字 | `git tag --contains` 只有 `dsh-v0.2.2-rc.2` |
| `3cd0624b8d refactor(subagent): list descendants without a scope switch` | 2026-10-15 | **删除 `list_agents` 的 `scope` 参数**（rc.1 该文件 `:25/:29/:49-51` 仍有 `ListAgentsScope`；rc.2 变成 `parameters: {}`） | 只有 `dsh-v0.2.2-rc.2` |
| `35018c3726 feat(team): use one Session switch and shared Subagent panel` | 2026-10-20 | Team 工具改为**按会话 Team 开关**动态可见（`when: ({agent}) => enabled(agent)` + TEAM_POLICY section 同条件） | 只有 `dsh-v0.2.2-rc.2` |
| `e180fce05a feat(team): enable new root Team mode through Cordis configuration` | — | 增加 `defaultEnabled` 配置（默认 `false`） | 在 rc.2 |
| `6cc45f22bd feat: 在内置配置中关闭 subagent 和 Team 的 interrupt 工具 (#7986)` | 2026-11-07 | **shipped 组合里 `interrupt: false`**，`interrupt_agent` 不再下发给模型 | 在 rc.2 |
| `d05e9fbd3c refactor(team): remove the relocated experimental package sources` | 2026-10-20 | 清掉 `packages/experimental/*`，team 包落到 `packages/team/*` | 只有 `dsh-v0.2.2-rc.2` |

**替代方案（上游设计意图）**：`.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md`（Status: implemented）——「Agent Teams 的成员就是 subagent」，不再有第二套 roster / 同义工具 / 私有投递适配器。落地上：

- 创建成员 → `subagent`（同进程 spawn）或 `subagent_fork`（继承上下文）；
- 通信 → 统一 `send_message({ agent, message })`（按 `list_agents` 给出的名字）；
- 看板 → `team_task_*`，但**只有根会话把 Team 开关打开才可见**。

---

## 3. rc.2 真正暴露的委派工具面 + 可见性开关

**组合定义**：`packages/bundle/base/cordis.patch.yml:363-416`

| 行 | 插件 | 作用 |
|---|---|---|
| `:363-364` | `@deepseek-ai/dsh-subagent` | 子代理运行时 |
| `:366-369` | `@deepseek-ai/dsh-agent-team`（`maxTasks: 256`） | Team 服务（任务板 / 开关 / 投影） |
| `:371-372` | `@deepseek-ai/dsh-tool-agent-team` | 注册 `team_task_*`（无配置 → `defaultEnabled` 不生效） |
| `:374-381` | `subagent-spawn-in-process` / `subagent-fork-in-process` | 两种 provider（`spawn` / `fork`） |
| `:386-389` | `@deepseek-ai/dsh-tool-subagent-control`（`interrupt: false`） | `send_message` / `list_agents` / `wait_agent`（**不含 `interrupt_agent`**） |
| `:391-405` | `@deepseek-ai/dsh-tool-subagent` ×2 | `subagent` + `subagent_fork` |
| `:415-416` | `@deepseek-ai/dsh-tool-workflow` | `workflow` |

**Team 开关（这就是「team 工具时有时无」的机制）**

- 默认关闭：`packages/team/agent-team/src/index.ts:51`（`defaultEnabled: z.boolean().default(false)`）、`:71`。
- 启动期仅在 `defaultEnabled` 时自动开启新根会话：同文件 `:79-86`（`source !== 'startup'` / `origin === 'subagent'` 均跳过）。
- 判定：`:94 isEnabled(caller)`；写入：`:112 async setEnabled(agent, enabled, signal)`，**只允许根会话**（`:… throw new TeamError('change Team mode from the root Session', 'TEAM_LEAD_REQUIRED')`），持久化为 `team/mode` 事件（`:116`）。
- Web 侧开关：`packages/client/ui-agent-team/src/client/mount.ts:43-44` 调 `remote.agentTeams.setEnabled(sessionId, enabled)`——即用户在会话头部点 Team 开关。
- 开关怎么作用到工具：`packages/team/tool-agent-team/src/index.ts:102-107 enabled()` → `ctx.agentTeams.isEnabled(agent)`；每个工具注册带 `{ when: ({agent}) => enabled(agent) }`（`:141/:182/:198/:234`）；TEAM_POLICY section 同条件（`:113-116`）。
- 官方文档同口径：`docs/tool-catalog.md:48`「Enabling Team mode on the root Session adds task-board guidance…」。

**没有「flat 模式」**：rc.2 源码 `grep -rn "\bflat\b" packages/team packages/subagent` 只命中 `Array.prototype.flat` 之类测试代码。`flat` 是本插件自定义概念（`index.js:412 FLAT_LEAD_APPENDIX`、`:423 MEMBER_NUDGE_FLAT`），宿主不认。

---

## 4. 「section 能否感知当前工具清单」——**可行**（有源码 + 宿主先例）

### 4.1 证据链

| 环节 | 证据 |
|---|---|
| section 的 text 是回调 | `packages/core/system-prompt/src/index.ts:64` `readonly text: string \| ((context: AssembleContext) => string)` |
| 基础 `AssembleContext` | 同文件 `:42-49`：`{ scope?: ScopeKey; signal?: AbortSignal }`，且注释写明是 **Merge-extensible** |
| 合并扩展 `agent` / `modelSelection` | `packages/core/agent/src/runtime-types.ts:19-24` `declare module '@deepseek-ai/dsh-system-prompt' { interface AssembleContext { agent?: Agent; modelSelection?: Readonly<ModelSelection> } }` |
| 合并扩展 `toolSet` | `packages/core/tools/src/index.ts:19-23` `{ toolSet?: ResolvedToolSet }` |
| 装配顺序（先定工具、再装配 prompt） | `packages/core/agent-loop/src/agent.ts:298` `tools.resolve({ agent, modelSelection, signal })` → `:300` `systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection, toolSet })` |
| `scope` 与 `agent` 一起给 | `packages/core/agent/src/dispatch.ts:174-176` `return { agent, scope: agent, ...signal }` |
| 拿可见工具名 | `packages/core/tools/src/index.ts:305-307` `definitions(scope?, toolSet?)` → `[...toolSet.view(scope).values()].map(d => d.name)`；点查 `:239-240` `get(name, scope, toolSet)` |
| `toolSet` 的内容 | `packages/core/tools/src/contracts.ts:128-137` `ResolvedToolSet.view(scope): ReadonlyMap<string, ToolDefinition>`；`ToolDefinition.name` 见同文件 `:27` / `:182` |
| `when` 在 resolve 时求值 | `packages/core/tools/src/index.ts:264-280`（逐个 `await registration.when(context)`，通过才进 `admitted`） |
| 宿主自己的先例（同一写法） | `packages/subagent/tool-subagent-control/src/index.ts:90-105`：`text: ({ agent, scope, toolSet }) => … ctx.tools.get(sendMessage.name, scope, toolSet) === sendMessage …` |
| 官方文档背书 | `packages/core/system-prompt/README.md:70`「Tool-aware section callbacks use `context.toolSet`…」；`:162`「tool-guidance plugins use `text({ scope, toolSet })` and `ctx.tools.get(name, scope, toolSet)`」 |

### 4.2 可直接用的调用示例（与宿主写法同构）

```js
systemPrompt.section({
  name: SECTION_NAME,
  order: SECTION_ORDER,           // 57，自由数值，合法
  text: (context) => {
    const { scope, toolSet } = context ?? {}
    // 关键：必须传 toolSet；省略它读到的是「注册期可见」集合，门控工具会误报存在
    const visible = new Set(
      (ctx.tools?.definitions?.(scope, toolSet) ?? []).map(d => d.name),
    )
    const hasTeamBoard = visible.has('team_task_create') && visible.has('team_task_update')
    const hasInterrupt = visible.has('interrupt_agent')
    const hasSubagent = visible.has('subagent') || visible.has('subagent_fork')
    return renderNudge({ hasTeamBoard, hasInterrupt, hasSubagent })  // 按实际能力裁剪文案
  },
})
```

只用 `context.toolSet.view(scope)` 也能做（`view(scope)` 直接返回 `ReadonlyMap<string, ToolDefinition>`），这样连 `ctx.tools` 都不需要；但要让 TS 看见 `toolSet` 字段，插件需 `import type {} from '@deepseek-ai/dsh-tools'`（触发声明合并）。若走 `ctx.tools.*`，`inject` 里要加 `'tools'`（当前插件是 `index.js:22 inject = ['commands','systemPrompt','subagents']`）。

### 4.3 三个必须知道的坑

1. **不能省 `toolSet`**：`definitions(scope)` 走 `view(scope).visible`（注册期可见，`index.ts:306`），而 `team_task_*` 是 `when` 门控——省略 `toolSet` 会在 Team 开关 OFF 时**照样看到** `team_task_create`，把 bug 判反。必须 `definitions(scope, toolSet)` / `get(name, scope, toolSet)`。
2. **`toolSet` 可能 `undefined`**：只在「模型步」装配里存在（`agent.ts:298-300`）；诊断/旁路装配没有。回退到 `ctx.tools.definitions(scope)` 并接受其近似。
3. **`text` 必须同步返回 `string`**：没有 async 形式；`ctx.tools.get/definitions` 恰好是同步 API，可用。

### 4.4 另一条（更彻底）的路：把 Team 开关打开

如果产品上就是要「提示词说 Lead 用看板，看板就必须在」，那不该只改文案，而应让插件主动开 Team：

- API：`ctx.agentTeams.setEnabled(agent, true, signal)`（`packages/team/agent-team/src/index.ts:112`），**仅根会话可调用**，非根抛 `TEAM_LEAD_REQUIRED`；异步、需 `inject` 加 `'agentTeams'`。
- 时机：`/using-agent-team on` 的命令 handler 里对**根 agent** 调一次；成员会话靠 `isEnabled(rootOf(caller))` 派生，不用各自开。
- 备选：文档要求用户在会话头部点 Team 开关（UI 路径见 3. 的 `mount.ts:43-44`）；或在 profile 里给 `agent-team` 配 `defaultEnabled: true`（示例 `apps/cli/config/examples/team-mode.yml:3`）。

---

## 5. 插件 API 在 rc.2 的兼容性确认

| API | rc.2 状态 | 证据 |
|---|---|---|
| `systemPrompt.section({ name, order, text, interpolate?, complete? })` → `() => void` | **在**，签名未变；`order` 只校验 finite（`57` 合法），注册/释放都发 `system-prompt/change` | `packages/core/system-prompt/src/index.ts:485-494` |
| `systemPrompt.getSectionOrder(name)` | **在**；命名序表里 `TEAM_POLICY: 600`、`SUBAGENT_DELEGATION: 120`、`TOOL_SUBAGENT: 2800` | `:501-503`、`:140`、`:182`、`:162` |
| `agent.inject(message)` | **在**（下一步前投递模型可见上下文，不唤醒） | `packages/core/agent/src/runtime-types.ts:271` |
| `agent.steer(message)` | **在**（空闲起一轮、运行中下一步送达） | 同文件 `:261` |
| `agent.followup(message)` | **在**（排在 steer 之后的新一轮） | 同文件 `:252` |
| 身份判定 | rc.1 `agentTeams.tryMembership` 已被 rc.2 的 `ctx.subagents.rootOf(caller)` 取代（插件已做双分支，`index.js:8/339-362`） | `packages/team/agent-team/src/index.ts:94` |

结论：**插件依赖的 prompt/命令 API 在 rc.2 全部存在，不需要为 API 变更改代码**；需要改的是「工具存在性假设」与「`interrupt_agent` / `team_task_*` 措辞」。

---

## 6. 给实现者的 5 条要点

1. **别再静态断言工具存在**。`LEAD_NUDGE` / `MEMBER_NUDGE(_FLAT)` 里写死 `team_task_create`、`interrupt_agent` 是根因（`index.js:414 / :420 / :423`、文案模板 `:478-481`）。改成在 section 的 `text(context)` 里按 `context.toolSet` 派生「本会话真实可用的委派工具集」，再拼文案。
2. **判定必须带 `toolSet`**（第 4.3 节坑 1）。否则 Team 开关 OFF 时 `team_task_*` 会被判成「存在」，把一个真实的降级场景测成通过——这是本任务最容易踩的假绿。
3. **按能力做三档降级**：`team_task_*` 在 → 保留看板 + write_scopes/blocked_by 语义；不在 → 删掉看板、claim/complete、`team_task_update` 措辞，只讲 `subagent` 拆派 + `send_message` 交回；`interrupt_agent` 在 → 才允许写「interrupt_agent 收敛成员」，否则改成「send_message 交回 + Lead 不再唤醒该成员」。
4. **用 rc.2 的真实名字**：`subagent` / `subagent_fork` / `send_message({ agent, message })` / `list_agents({})` / `wait_agent`；删掉 `spawn_teammate`、`list_agents(scope=)`、`send_message(target=)`、`interrupt_agent` 的旧写法（`spawn_teammate` 只剩客户端死标签，别被 `slot-catalog.ts:5605` 的 keyDomain 注释误导）。
5. **想要「提示词说看板 → 看板真在」就主动开 Team**：在 `/using-agent-team on` 的 handler 里对根 agent 调 `ctx.agentTeams.setEnabled(agent, true, signal)`（`inject` 加 `'agentTeams'`，非根会抛 `TEAM_LEAD_REQUIRED`），并把「开失败就降级文案」作为兜底。只开提示词、不开 Team 开关，在 rc.2 必然出现「提示要求用不存在的工具」。
