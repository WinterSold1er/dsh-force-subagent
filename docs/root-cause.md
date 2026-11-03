# 强制委派 nudge 未生效根因（会话「密评文档编写与截图」）

> 取证方式：**DIRECT**。本轮先批量派发 3 个 subagent（minor-5090 / qwen3.8-flash-next-iq3_xxs）+ 1 个探活，4 个全部 `failed before it finished, left no closing message` → 子代理路由不可用，改为本成员只读命令取证。未修改 `index.js` / `tests/`。

## 结论（一句话）

**注入链路是好的（lead 与 teammate 的系统提示词快照里都确实有 nudge），失败点是覆盖与遵从**：① 4.4.5 实作时插件尚未安装（10-29 21:45 才装、23:16 才重启 host），那批 teammate 的**每一个** `system/message` 快照都不含 nudge；② 插件生效后，lead 拿到 nudge 的当轮仍先跑 `bash` 直接干活、reasoning 零提及团队规则——属「注入成功但没照做」。

## 时间线（均可用文末命令复现）

| 时间（+08:00） | 事件 | 证据 |
| --- | --- | --- |
| 2026-10-29 11:22:12 | 失败会话 `a77c0d43` 创建，cwd=`/home/csy/Work/twoplus` | projcache `record.identity.createdAt=1793244132017` |
| 2026-10-29 17:17:22 | turn 1 step 1 系统提示词快照，**无 nudge** | `system/message`，插件未装 |
| 2026-10-29 17:30–17:51 | 7 个 teammate 会话创建（w1/w2/w3/w6/shotsmith/integrator/reviewer） | 各自唯一/前几个 `system/message` 全 `-1` |
| 2026-10-29 21:21:29 | 插件 `index.js` 落盘 | `stat index.js` |
| 2026-10-29 21:45:41 | 软链 + profile `package.json` 写入（第 41 行列表项） | `stat`；`nl -ba ~/.dsh/profiles/web/package.json \| sed -n '41p'` |
| 2026-10-29 23:16:49 | 当前 host 启动（PID 3498005，rc.3，:3080） | `ps -eo pid,lstart,cmd` |
| 2026-10-30 10:38:57.793 | turn 2 step 1 系统提示词快照，**lead nudge 在偏移 4963 / 全长 15110** | 见证据 E2 |
| 2026-10-30 10:38:57.794 | 用户消息「4.4.5.2以及后面确实不需要我改…」 | `user/message` |
| 2026-10-30 10:39:34 | lead 第一个动作 = `bash`（直接查模板图） | `tool/call` `bash` |
| 2026-10-30 10:40:38 | 用户手动 `/team-recursive-orchestration` | `user/message` |
| 2026-10-30 10:41:15 / 10:41:48 | `team_task_create`×2 / `spawn_teammate`×2 | `tool/call` |
| 2026-10-30 10:41:49 | 新 teammate w7(`ca22c257`) 首个快照**含 teammate nudge，偏移 4979** | 证据 E4 |
| 2026-10-30 10:42:34 | reviewer(`00f6e08c`) 第三次快照开始含 nudge（此前两次 `-1`） | 证据 E4 |
| 2026-10-30 10:43:14 | 用户施压「成员只是编排者，不干活」 | `user/message` |

## 机制：快照为什么能证明「收到 / 没收到」

1. 每个 step 都会重新装配：`packages/core/agent-loop/lib/types/agent.js:218-233` `preStep()` → `systemPrompt.assemble(...)`。
2. 装配结果经 `renderPrompt`（`agent.js:370-373`）后由 `systemPrompt.project(...)` 决定提交几条 `system/message`（`agent.js:376-384`）——**这些就是模型实际看到的系统提示词**，落盘在 `session.v4.jsonl.zstd`。
3. section 的 `text` 在每次 `assemble` 求值（`docs/prompt-plugin-api.md:112`，`:662`）；`refreshContext` 明确「sections retain the accepted assembly; their providers do not rerun」（`packages/core/system-prompt/lib/types/index.js:360-368`）——所以把 role 判定放进 `text` 是对的，不会冻结。
4. 角色判定：`packages/experimental/agent-team/lib/types/roster.js:63-89`：先 `this.ctx.agents.get(agent.id) !== agent → undefined`（`:64-65`，陈旧/非活身份）；有 `parentSession` 时 member 且 `phase ∈ {active, provisioning}` → `teammate`（`:71-73`），否则**带 subagentDescriptor 的 child → `undefined`**（`:78-79`），**普通 host fork（无 descriptor）→ 隐式 `{role:'lead'}`**（`:80`）；无 `parentSession` 时同理：subagent child → `undefined`（`:87-88`），**root → 隐式 `lead`**（`:89`；`subagentDescriptor` 见 `:428-431`，session 内 fold 出 descriptor 才算 child）。**因此本插件对任何 root/fork agent 注入 lead 文案是 Agent Teams 部署的预期行为，不是「非团队成员渲染空串」；只有带 subagentDescriptor 的子代理才渲染空串。** 实证：`--home-csy-Code-installer-deepseek-harness--/session-338226ce-...` 的 `team/member` 记录数为 **0**，但其首个 `system/message`（t=1793329059166）在偏移 4963 命中 lead 文案。
5. 位置由 `SECTION_ORDERS` 决定：`packages/core/system-prompt/lib/index.js:10-43`，`TEAM_POLICY: 600`、最后一段 `DEPLOYMENT_PERSONA_SUFFIX: 10200`。旧版插件用 `getSectionOrder('TEAM_POLICY') + 1 = 601` → nudge 落在 15110 字符提示词的 **33% 处**，其后还有约 10k 字符的 tool/skills/persona 内容（比例是实测事实；「位置导致未遵从」只是未验证假设，见「残留未知」第 2 条）。

## 证据（可复制）

E1. 插件与激活时间

```bash
stat -c '%y %n' ~/.dsh/profiles/web/node_modules/dsh-force-subagent \
  /home/csy/Code/Github/dsh-force-subagent/index.js ~/.dsh/profiles/web/package.json
# 2026-10-29 21:45:41.116  node_modules/dsh-force-subagent（软链）
# 2026-10-29 21:21:29.279  index.js
# 2026-10-29 21:45:41.161  ~/.dsh/profiles/web/package.json
ps -eo pid,lstart,cmd | grep 'rc.3/apps/cli/lib/bin.js web --port 3080'
# 3498005 四 10月 29 23:16:49 2026 ... --port 3080
```

E2. lead 在用户投诉消息的同一 step **确实**拿到 nudge

```bash
f=~/.dsh/sessions/--home-csy-Work-twoplus--/session-a77c0d43-e871-4691-8926-42b7f9af4b91/session.v4.jsonl.zstd
zstdcat "$f" | jq -r 'select(.type=="system/message" and .time==1793327937793) |
  .data.message.content[0].text as $p | "len=\($p|length) nudge_at=\($p|index("用户提示已到达"))"'
# len=15110 nudge_at=4963
```

nudge 前后原文（同一快照偏移 4700–5230）：

```
…Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.

用户提示已到达。本会话启用了 Agent Teams：不要独自实现。先用 team_task_create 建立任务 DAG 并划定互斥 write_scopes，再在单轮内批量 spawn_teammate 拉起成员，用 wait_agent 等待；你只做架构、拆解、调度、仲裁与最终验收，细节实现全部派发。

Tokens prefixed with @ are paths the user explicitly referenced.…
```

E3. lead 收到后仍先直连干活（行为证据）

```bash
zstdcat "$f" | jq -r 'select(.time>1793327937794 and .time<1793328038948) | "\(.time) \(.type) \(.data.name // "")"' | head
# 1793327937795 user/message
# 1793327937879 request/header
# 1793327974411 assistant/message
# 1793327974413 tool/call bash        ← 首个动作：bash
```

同一条 `assistant/message` 的 reasoning 全文 grep `nudge|委派|派发|subagent|Lead|team` **0 命中** → 模型没把团队规则纳入本轮推理。

E4. teammate 侧：插件安装前创建的**全无**，安装后创建的**有**

```bash
d=~/.dsh/sessions/--home-csy-Work-twoplus--
for f in "$d"/*/session.v4.jsonl.zstd; do
  zstdcat "$f" | grep -q '"parentSession":"session-a77c0d43' || continue
  id=$(basename "$(dirname "$f")")
  zstdcat "$f" | jq -r 'select(.type=="system/message")|"\(.time) \(((.data.message.content[0].text|index("你只是编排者")) // -1))"'
  echo "-- $id"
done
```

结果（`-1` = 该快照无 teammate nudge）：

| 会话 | 创建/快照时间 | nudge |
| --- | --- | --- |
| `54c194bf` w1 | 17:30:45 / 17:30:57 / 17:50:28 / 17:51:14 | -1 / -1 / -1 / -1 |
| `d3da5fce` w2 | 17:30:46 起 3 次 | 全 -1 |
| `02d91f8a` w6 | 17:42 起 2 次 | 全 -1 |
| `d3d5ff44` shotsmith | 17:42 起 2 次 | 全 -1 |
| `117cf623` integrator | 17:43 起 3 次 | 全 -1 |
| `996b172d` w3 | 17:43 起 2 次 | 全 -1 |
| `00f6e08c` reviewer | 17:43 / 17:50 无；**10:42:34 有（4979）** | -1 / -1 / 4979 |
| `ca22c257` w7 | **10:41:49 首个快照即有（4979）** | 4979 |

结论：**teammate 侧不是「判定失败」，而是「快照时代」问题**——上表前 6 个 agent 的全部生命周期都在插件安装（21:45:41）之前，那时不存在该 section；reviewer 因会话延续到 10:42 才重建提示词才拿到；w7 在插件生效后创建，首个装配即命中。

E5. 普通 subagent 拿不到 teammate 文案（设计缺口，非 bug）

`64c7dadf`（label=`router probe`，本成员探活子代理，`subagent/descriptor` `{"provider":"spawn","mode":"continuable"}`，10:48:11 首个快照）无 nudge：`tryMembership` 对带 subagentDescriptor 的 child 返回 `undefined`（`roster.js:87-88`），插件渲染 `''`。

E6. 两处「成功会话」线索被证伪

`~/.dsh/storages/session_projcache/sessions/08c3e60a-*.json`、`33096296-*.json` 里命中的是**插件开发任务的任务书原文**（含 `NUDGES` 源码），不是注入痕迹：

```bash
grep -o 'force-subagent[^",]\{0,80\}' ~/.dsh/storages/session_projcache/sessions/08c3e60a-2ac9-4b90-99cb-aaadee81a59b.json | head -2
# force-subagent。目标：实现宿主插件 dsh-force-subagent（零依赖…
```

真正证据只有 `session.v4.jsonl.zstd` 的 `system/message` 快照。

## 最小修复建议（task-2 范围，`index.js` 单文件）

1. **把 nudge 移到系统提示词末尾（锚点方案，不写魔法数）**：`index.js:23` 定义 `ORDER_ANCHOR = 'DEPLOYMENT_PERSONA_SUFFIX'`（`SECTION_ORDERS` 表内末位常量 `10200`，见 `packages/core/system-prompt/lib/index.js:42`），`index.js:73-76,100` 经 `sectionOrder(systemPrompt)` 取 `getSectionOrder(ORDER_ANCHOR) + 1 = 10201`；锚点查不到时显式抛错并点名该常量。**旧值**：`getSectionOrder('TEAM_POLICY') + 1 = 601`。落位动机只是推断（nudge 埋 15110 字符的 33% 处，其后还有约 10k 字符工具说明与 PONYTAIL 强指令），**位置与未遵从的因果关系尚未验证**，见「残留未知」第 2 条。
2. **文案加动作门禁**：`NUDGES`（`index.js:16-19`）开头补一句硬的，例如「本轮第一个工具调用必须是 team_task_create 或 spawn_teammate；先跑 bash/read/edit 即视为违规。」现文案 110 字、纯描述，无否决句式。
3. **覆盖二级委派**：`index.js:48-51` 中 `membership === undefined` 时不再直接返回 `''`；若 `agent.session.header.parentSession !== undefined`（是子代理但不是 roster 成员，见 E5），返回 `NUDGES.teammate`。否则 `subagent` 派出的下级代理永远收不到任何提醒。

（不改安装方式即可；`apply` 的 `ctx.agents.list()` 回放 + `agent/created` 已能覆盖插件加载后存活的 agent——E4 的 w7 就是证据。安装后**必须重启 host**，否则已 dispose 的旧会话无法追溯，实测 `~/.dsh/logs` 最后写入 2026-10-12，无运行时加载日志可查。）

## 残留未知

1. **模型内部是否「读到」nudge**：只能证明提示词快照含 nudge（E2）+ 同轮 reasoning 零命中（E3）。二者合起来支持「收到但没照做」，无法直接观测注意力。
2. **「位置 → 未遵从」是未证实假设**：只证实 nudge 位于 15110 字符系统提示词的 33% 处（E2），未做 A/B（同一文案置于末尾 vs 中段）验证位置对遵从的影响；「埋没导致忽略」属推断，不能作为根因定论。
3. **同 token 竞争的具体权重**：为何 w7（teammate）拿到 nudge 后立刻按它执行（reasoning 原文 "The system prompt says I'm an orchestrator only"），而 lead 同款文案当轮不执行——属模型采样差异，日志不可证。
4. **cordis 加载证据**：文件层 `~/.dsh/logs` 无 10-29/10-30 记录；journald（宿主 PID 4040148，11:18:01）可见加载期仅 4 条 lsp/hooks `ERR_MODULE_NOT_FOUND`、**不含**本插件 → 间接支持无 `apply` 报错；快照仍为主要证据（E2/E4）。
5. 另一宿主（PID 2166124，`:3088`，`deepseek-harness-test`）使用 `~/.dsh-test` profile，与本问题无交集；未验证其在 10-30 是否有同类会话。
