# dsh-force-subagent 交付说明

一句话：`/using-agent-team` 从"按角色追加 user 消息"改为"命令门控的系统提示词 section"——一个命令、每会话开关、零依赖。

## 行为变化

| 维度 | 旧行为 | 新行为 |
| :--- | :--- | :--- |
| 触发 | `agentTeams` 自动按角色（`lead` / `teammate`） | 会话内执行 `/using-agent-team` 后开启，`off` 关闭 |
| 注入点 | `agent/pre-step` waterfall 追加 user 消息（每批新消息一次） | 全局 `systemPrompt.section`，名 `force-subagent:agent-team`，order 57，每轮 assemble 求值 |
| 状态 | 不落盘，依赖每个消息批次 | 不落盘，门控派生自宿主 `command/run` 事件（`data.name === 'using-agent-team'`；`args === 'off'` 关闭，裸命令 / `on` / `<task>` 开启） |
| 依赖 | `inject = ['agentTeams']` | `inject = ['commands', 'systemPrompt', 'subagents']`；`subagents` 为 DSH 核心服务（子代理模型路由注入包裹 `startActivation` 的前提），缺失时 Cordis 注入门控使插件不进入 ACTIVE；`ctx.get` 快照为空时 `ctx.logger.warn` 点名缺失服务并停用 |
| 文案 | `lead` / `teammate` 两套 | 单套强制委派提醒 |
| 命令冲突 | 无此逻辑 | `commands.register` 抛 "already registered" 时 warn 点名旧版 `dsh-plugin-subagent-director`，只跳过命令注册，section 照常工作；其他错误原样抛出 |

不伪造 user 消息、不挂 `agent/pre-step`、不注册自定义会话事件类型。

## 生效步骤

1. 安装并接线：`./scripts/install.sh`（先 `--dry-run` 预演）。完整步骤与验证命令见 [docs/install.md](install.md)。
2. 按 [README 的部署一节](../README.md#部署) 操作：先把 `dsh-plugin-subagent-director` 升级到已删除该命令的版本，再重启 dsh web host（重启会终止当前 agent 会话）。
   - **必做：先升级 director，再重启 host。** 已装 `dsh-plugin-subagent-director@0.6.0-beta.3` 的机器仍会注册 `/using-agent-team`（该版本早于命令删除，本仓库的删除尚未发布/安装）。
   - 顺序错了的后果：本插件重启后 warn 并跳过自身命令注册，但 `systemPrompt.section` 照常工作（门控来自宿主 `command/run` 记录）；此时执行 `/using-agent-team` 会同时触发旧 director 的编排与本插件 section，同一会话出现两段 agent-team 提示。不要先重启，也不要假设本仓库的改动已生效。
3. 在会话里执行 `/using-agent-team`（或 `on` / `<task>`）；之后每轮 system prompt 都带该 section，`off` 关闭。

## 回滚

- 只关提醒：`/using-agent-team off`（立即生效，不需重启）。
- 卸载插件：`./scripts/install.sh --uninstall`，然后重启 host。脚本移除依赖、bundles 条目与符号链接，保留备份。
- 还原 profile 配置：用 `~/.dsh/profiles/web/package.json.bak-<YYYYmmdd-HHMMSS>` 覆盖后重启 host。
- 升级过 director 的部署：如需恢复旧入口，降级到仍注册 `/using-agent-team` 的版本；两个插件同时注册时本插件会 warn 并跳过命令，提示功能仍由本插件 section 提供。

## 边界

- **两个入口并存**：命令 `/using-agent-team` → 本插件（按会话 sticky，门控来自 `command/run` 事件）；自然语言"使用 agent team" → `dsh-plugin-subagent-director` 的 per-turn 模式。两者互不替代。
- **单次命令触发不会双注入**：宿主对命令只记录 `command/run` 事件，不写 user 消息；本插件只注册一个 section、不追加消息，因此一次触发只产生一份提示。
- **已知双 section**：同一会话先执行 `/using-agent-team`、再用自然语言触发 director，可能同时出现 `force-subagent:agent-team`/57 与 `orchestrate-mode`/55 两段提醒。这是已知行为，不做代码绕过；要避免就固定用一种入口，或先 `off` 再用另一种。另一处来源是升级顺序错误（旧 director 未升级即重启），见[生效步骤](#生效步骤)的必做顺序。
- **提示词级提醒，不是工具级强制**：插件只往 system prompt 写文本，不拦截调用、不改变工具可用性；模型是否照做仍取决于提示词约束。
- **服务依赖**：需要 `commands` 与 `systemPrompt`（`inject` 声明）。任一缺失时 Cordis 不调用 `apply`；`ctx.get` 返回空（isolate 场景）时插件 `ctx.logger.warn` 点名缺失服务并返回，插件停用、不静默生效。

## 已知测试缺口（client.js UI，2026-11-05 冻结版）

- 工作区服务不可用 / 允许模型策略不可读两条 `role="alert"` 只有源码断言与纯函数错误态断言，未做挂载渲染断言。
- `fresh.revision` 围栏：行为测试断言 `mutate(operations, 7)`，但 7 是 fixture 常量，未模拟外部 revision 变更，“保存前重读快照”无语义级行为证明。
- 未覆盖交互：全局开关 `onChange`、目录失败重试按钮、`form.mutate` 返回 false 的冲突分支、`writable:false` 只读门控。
- `bindSession` 无观测；入口测试只断言 `layout.selectPanel(PANEL_ID)`，测试标题不声称“绑定会话”。
- `routableProviders` 过滤不适用为既定行为（宿主 `groups` 已过滤空模型，`routableProviders` 由 `groups` 派生），行为测试显式钉住该行为，不作为期望特性。

