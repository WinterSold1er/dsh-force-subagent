# 会话「密评材料需要再进行一轮修改」成员复用取证

结论（先看）：该会话里发生的是 **A 类复用（Lead 主动 send_message / team_task_update reopen 唤醒同一成员）**，并叠加 **C 类误读（成员完成任务后 roster 行仍以 `inactive` 存在，宿主没有删除成员的 API）**。**B 类（宿主重启/resume 重建 roster）在本会话无任何证据**。被复用的成员是 `cli-dev` 与 `docx-editor`，二者自始至终是同一个成员记录，从未被重新 spawn。

## 0. 数据定位

| 项 | 值 | 证据位置 |
|---|---|---|
| 会话 id | `session-8ddb18f7-5a6d-43b0-8d34-c02d4ceaafef` | 目录名 `/home/csy/.dsh/sessions/--home-csy-Work-twoplus--/session-8ddb18f7-5a6d-43b0-8d34-c02d4ceaafef/` |
| 标题 | `密评材料需要再进行一轮修改` | `/home/csy/.dsh/storages/session_projcache/sessions/session-8ddb18f7-5a6d-43b0-8d34-c02d4ceaafef.json` → JSON 键 `record.rows.title.val` |
| cwd | `/home/csy/Work/twoplus` | 同上 `record.identity.cwd` |
| 创建时间 | 1793881037387 = **2026-11-05T20:17:17.387+08:00** | 同上 `record.identity.createdAt`；journal 首行 `{"type":"session","version":4,"id":"session-8ddb18f7-…","createdAt":1793881037387,…}` |
| 事件日志 | `session.v4.jsonl.zstd`（压缩 835 401 B / 解压 2.84 MiB / 196 帧） | `/home/csy/.dsh/sessions/--home-csy-Work-twoplus--/session-8ddb18f7-5a6d-43b0-8d34-c02d4ceaafef/session.v4.jsonl.zstd` |

**快照说明**：本会话仍在运行，journal 持续增长。下文 `L<n>` 指 **21:38 抓取的 381 行快照**（`zstd -dc … > /tmp/t1-journal.jsonl`，源文件 mtime 21:37）。成员日志快照：cli-dev 1224 行 → `/tmp/t1-cli.jsonl`；docx-editor 1278 行 → `/tmp/t1-docx.jsonl`。

检索起点命令与结果：`grep -rl "密评材料需要再进行一轮修改" /home/csy/.dsh` → 命中 3 个 projcache 文件（`ee696129-…`=本取证会话自身；`session-18cc2aa0-…`=用户提问所在会话，`record.rows.title.val="任务完成后成员仍被复用"`，`lastPromptAt=1793885644163`=21:34:04；`session-8ddb18f7-…`=目标会话）。vectr 用于取历史笔记（#119 等）；vectr 索引只含 `dsh-force-subagent`（31 文件），不含 installer 源码，故源码核验降级为 `read`/`grep -n`。

## 1. 成员只有 3 个，且 `team/member` 事件仅 provisioning→active 两次

| 时间 | 事件 | 摘录 | 位置 |
|---|---|---|---|
| 20:28:36.827 | `spawn_teammate name=cli-dev` | — | journal L82 `data.arguments.name` |
| 20:28:36.843 / 20:28:37.199 | `team/member` | `id=713f62c8-5635-453d-abd6-a64e496aaece name=cli-dev phase=provisioning` → `phase=active` | L83 / L85 `data.member` |
| 20:28:37.355 | `spawn_teammate name=docx-editor` | — | L87 |
| 20:28:37.363 / 20:28:37.759 | `team/member` | `id=94036895-fcdf-42e4-b155-e1dfca8d2d8b name=docx-editor phase=provisioning` → `active` | L88 / L90 |
| 21:35:44.324 | `spawn_teammate name=board-runner` | 新成员，负责新建 task-4 | L325；member 事件 L326/L328 `id=2481f483-0746-4375-beaa-827cc2ac7bff` |

全程 `team/member` 事件共 6 条 = 3 成员 × 2 次，**没有任何成员的第三条 member 事件，也没有 member 删除/重建事件**。成员自身会话日志首行证明成员运行时 id 就等于 member id：`/tmp/t1-cli.jsonl` L1 `"id":"713f62c8-…","parentSession":"session-8ddb18f7-…"`；`/tmp/t1-docx.jsonl` L1 `"id":"94036895-…","parentSession":"session-8ddb18f7-…"`。

## 2. 核心证据：A 类复用链（cli-dev 完成 task-1 之后被继续派活）

Lead 侧 journal（L）与 cli-dev 侧 journal（C）交错，时间戳互相吻合：

| 时间 | 侧 | 事件 | 摘录 | 位置 |
|---|---|---|---|---|
| 20:29:29.586 | cli-dev | `team_task_update action=claim task-1` | — | C L32 |
| **21:01:48.486** | cli-dev | **`team_task_update action=complete task-1`** | — | C L1000 |
| 21:01:48.532 | lead | `team/task` | `task-1 status=completed revision=3 ownerId=713f62c8-…` | L218 `data.task` |
| 21:02:07.876 | cli-dev | `send_message target=lead`（完成汇报） | — | C L1005 |
| 21:02:21.020 | cli-dev | `send_message target=docx-editor` | 同刻唤醒 docx-editor（见 §3 turn 5） | C L1010 |
| **21:02:43.594** | lead | **`send_message target=cli-dev`（完成之后）** | `用户裁定已下：材料改引产品 show global state…按此收口 global_state.rs` | L221 `data.arguments` |
| 21:02:44.128 | cli-dev | inbox 注入 | `Team message from lead:` | C L1026 `data.inserted[0].content[0].text` |
| **21:03:16.482** | lead | **`team_task_update action=reopen task_id=task-1`** | — | L231 |
| 21:03:16.498 | lead | `team/task` | `task-1 status=pending revision=4`（已 completed 的任务被重新打开） | L232 `data.task.status/revision` |
| 21:04:01.279 | lead | `send_message target=cli-dev` | `task-1 已 reopen（还差一个交付物，代码本身验收通过）` | L248 |
| 21:04:01.291 | cli-dev | inbox 注入 | `Team message from lead:` | C L1069 |
| **21:07:43.766** | cli-dev | **`team_task_update action=claim task-1`（二次认领）** | — | C L1198 |
| 21:07:43.921 | lead | `team/task` | `task-1 status=in_progress revision=6 ownerId=713f62c8-…` | L259 |
| **21:08:01.862** | cli-dev | **`team_task_update action=complete task-1`（二次完成）** | — | C L1203 |
| 21:08:01.976 | lead | `team/task` | `task-1 status=completed revision=7` | L272 |
| 21:08:16 / 21:08:24 | cli-dev | `send_message lead` / `send_message docx-editor` | — | C L1208 / L1213 |
| 21:08:44 | cli-dev | `turn/end`（该成员唯一一轮 turn 结束） | — | C L1224 |
| **21:09:14.126** | lead | **`interrupt_agent target=cli-dev`** | — | L291 |
| **21:09:14.142** | lead | 工具返回 | **`{"previousStatus":"inactive"}`** → 中断时 cli-dev 已不在 live registry，该 interrupt 是空操作 | L292 `data.message.content[0].text` |
| 21:09:35 | lead | `assistant/message` 推理 | `"cli-dev is closed. Now ask the user…"`（Lead 自认为成员已关闭） | L300 `data.message.content[0].text` |

21:04:01 之后 Lead 再未向 cli-dev 发送任何消息（Lead 侧对 cli-dev 的最后一次 `send_message` 即 L248）。

## 3. 核心证据：docx-editor 的 6 个 turn 全部落在同一个成员会话内（每次唤醒都是复用，不是重建）

`/home/csy/.dsh/sessions/--home-csy-Work-twoplus--/94036895-fcdf-42e4-b155-e1dfca8d2d8b/session.v4.jsonl.zstd`（快照 C）：

| turn | start（C） | end（C） | 唤醒来源（Lead 侧时间，误差 ≤ 20 ms） |
|---|---|---|---|
| 1 | 20:28:37 (C L8) | 20:34:56 (C L398) | `spawn_teammate` 20:28:37.355 (L87) |
| 2 | **20:37:37** (C L401) | 20:41:15 (C L529) | Lead `send_message target=docx-editor` **20:37:37.401** (L139) |
| 3 | 20:41:49 (C L532) | 20:43:58 (C L626) | Lead `send_message` 20:41:49.137 (L170) |
| 4 | 20:44:10 (C L543→L44:10, C L629) | 20:47:13 (C L707) | Lead `send_message` 20:44:09.869 (L191) |
| 5 | 21:02:21 (C L710) | 21:13:58 (C L1068) | **同事发起**：cli-dev `send_message target=docx-editor` 21:02:21.020 (C-cli L1010) |
| 6 | **21:34:05** (C L1071) | 未结束（快照时仍在跑） | Lead `send_message target=docx-editor` **21:34:05.245** (L312) |

同一会话只有 **1 条 `session` 头（C L1）**、`turn/start` 6 次、`turn/end` 5 次 → 成员运行时身份从未重建，只是不断被追加新 turn。

**inactive → running 的直接对照**（`list_agents` 返回值快照）：
- Lead L138 `tool/result` @ 20:37:37.381：`{"target":"docx-editor","status":"inactive","model":"deepseek-v4.1-flash"}`
- Lead L139 `tool/call` @ 20:37:37.401：`send_message target=docx-editor`（**20 ms 后**）
- Lead L186 `tool/result` @ 20:43:58：`{"target":"docx-editor","status":"running","model":"qwen3.8-flash-next-iq3_xxs"}`

文件系统佐证（同一结论、独立于日志）：

| 成员 | 会话目录创建 | `session.lock` mtime | journal 最后写入 |
|---|---|---|---|
| cli-dev `713f62c8-…` | 20:28:36 | **20:28:36**（未再获取） | 21:08:44 |
| docx-editor `94036895-…` | 20:28:37 | **21:34:05**（被重新获取，与 L312 `send_message` 同刻） | 21:44:42（仍在写） |
| board-runner `2481f483-…` | 21:35:44 | 21:35:44 | 21:44:44 |

三个目录都是 spawn 时刻创建、从未新建 → 复用的是同一份持久会话。

## 4. C 类误读证据：完成任务 + 已 interrupt 的成员仍在 roster 中

Lead L354 `tool/result`（`list_agents`）@ **21:36:44**（即 task-1 完成 21:08:01 之后 28 分钟、`interrupt_agent` 之后 27 分钟）：

```json
[{"target":"lead","role":"lead","status":"running","model":"deepseek-v4.1-flash"},
 {"target":"cli-dev","role":"teammate","status":"inactive","description":"负责 task-1：CLI 设备认证状态命令与加密信息展示修正","provider":"spawn","context":"fresh","model":"deepseek-v4.1-flash"},
 {"target":"docx-editor","role":"teammate","status":"running","…":"…","model":"qwen3.8-flash-next-iq3_xxs"},
 {"target":"board-runner","role":"teammate","status":"running","…":"…","model":"qwen3.8-flash-next-iq3_xxs"}]
```

同一份 `tool/result` 中 cli-dev 的 `model` 从 running 时的 `qwen3.8-flash-next-iq3_xxs`（L267 @21:07:49）变成 `deepseek-v4.1-flash`；docx-editor 也出现同样现象（L138 inactive 时=lead 模型，L186 running 时=qwen）。这与 `roster.ts:475-477` 的 `availability(agent) = agent?.status === 'running' ? 'running' : 'inactive'` 一致：无 live 子运行时时视图退化，属于展示回退（推断，见 §6）。

`team_task_list` 侧（Lead L356 @21:36:45）仍返回 `"id":"task-1","status":"completed","ownerName":"cli-dev"`，看板行不消失。

## 5. B 类（宿主重启 / resume 重建 roster）：无证据，排除

| 检查 | 命令 | 结果 |
|---|---|---|
| 事件类型里是否存在 resume/recover/restart/roster | `grep -o -E '"type":"[a-z/]*(resume|recover|restart|roster)[a-z/]*"' <三个 journal>` | **0 命中** |
| 是否存在 fork / 继承 | projcache `record.identity` | 目标会话 `inheritedEventCount: 0`、`isSeeded: false`；成员 journal 首行 `parentSession` 单一且等于 Lead 会话 id |
| 会话头是否重复追加 | `grep -c '"type":"session"'` | 每个 journal 均为 **1** |
| 窗口内宿主进程是否重启 | `ps -eo pid,lstart,etime,cmd \| grep harness` | 提供 :3080（本 GUI URL）的进程 PID **4112586**，启动 **2026-11-05 20:13:59**，21:47 时 etime=01:33；覆盖 20:17→21:45 整个会话窗口，未重启。本取证进程 cgroup `dsh-subprocess-4112586-73dd64eeba7d.scope`（`/proc/self/cgroup`）即挂在同一宿主下 |
| 21:09–21:32 的 23 分钟空档是否重启 | Lead L301 `ask_user_question` @21:09:35 → L304 `tool/result` @21:32:21.897 | 空档是 Lead 阻塞在 `ask_user_question` 等用户，非重启 |
| `team/message/*` 事件 | `grep -c 'team/message'` | **0**（本版本不落 message 事件；消息只体现为 `tool/call send_message` + 成员侧 `agent/inbox/spliced`） |

## 6. 硬证据 vs 推断

硬证据（可直接回溯到路径+行/JSON 键）：§1–§5 全部时间戳与载荷（两个 journal 的 `L` 行号、`data.task.*`、`data.member.*`、`data.message.content[0].text`）；三个成员目录的 mtime 与 `session.lock` mtime；宿主 PID 4112586 的 `lstart`；`grep -c 'team/message'`=0；resume/restart 事件类型 0 命中；源码 `index.ts:145` `sendMessage`、`index.ts:244` `steerHostSubagentPrompt(...)`、`roster.ts:187-197` `interrupt`、`roster.ts:194` `if (live === undefined) return { previousStatus: 'inactive' }`、`roster.ts:475-477` `availability`（路径 `/home/csy/Code/installer/deepseek-harness-0.2.1-rc.5/packages/experimental/agent-team/src/`，`grep -n` 逐行确认）。

推断（非直接观测）：
1. `model` 字段在 inactive 时显示 Lead 模型 = 视图回退。依据是快照对照 + `roster.ts:475-477`，源码未写出该回退契约。
2. turn 2/6 由 `send_message` 触发。依据是 ≤20 ms 的时间吻合，且两次 `send_message` 与 `turn/start` 之间无任何其他工具调用；未观测到显式的 wake 事件。
3. 用户所述"被复用"最可能对应 §4 的 roster 残留（C）与 §2/§3 的唤醒（A）。用户原话不在该会话 journal 内，无法从数据直接确认其观察对象。
4. `interrupt_agent` 返回 `previousStatus:"inactive"` 解读为"该 interrupt 是空操作"，基于 `roster.ts:194` 的分支语义。

## 7. 结论（≤10 行）

1. 会话数据在 `/home/csy/.dsh/sessions/--home-csy-Work-twoplus--/session-8ddb18f7-5a6d-43b0-8d34-c02d4ceaafef/session.v4.jsonl.zstd`，成员日志在同目录下以 member id 命名的三个子目录。
2. 全会话只 spawn 过 3 个成员（cli-dev、docx-editor、board-runner），`team/member` 事件只有 6 条（provisioning→active），无任何重建。
3. `cli-dev` 于 21:01:48 完成 task-1，随后 Lead 在 21:02:43 / 21:04:01 继续向它发消息，并在 21:03:16 `reopen` 已完成的 task-1，导致它 21:07:43 二次认领、21:08:01 二次完成 —— 这就是"完成任务后还被复用"的实体。
4. `docx-editor` 的 task-2 全程 `in_progress`（rev 3，从未 completed），它被 4 次追加 turn（2 次来自 Lead 的 `send_message`、1 次来自同事 cli-dev 的 `send_message`、1 次来自 21:34:05 的 Lead 消息），复用方式同样是 `send_message` 唤醒 inactive 成员。
5. 机制是 `index.ts:145 sendMessage` → `index.ts:244 steerHostSubagentPrompt`，配合 `team_task_update action=reopen`：成员记录是持久对象，任务完成不会使其消失。
6. `interrupt_agent` 在 21:09:14 返回 `{"previousStatus":"inactive"}`（空操作），Lead 随即在推理中写下 "cli-dev is closed."，但 21:36:44 的 `list_agents` 仍列出 `cli-dev status=inactive` —— 宿主无删除成员的 API，"还在"不等于"在干活"。
7. 判定：**A 类为主，C 类叠加；B 类排除**（窗口内宿主进程未重启、无 resume/fork 事件、每份 journal 只有一个 session 头）。
