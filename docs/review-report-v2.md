# 对抗审查报告 v2（task-4）

**结论（第 3 轮，最终）：`VERDICT: REJECT`** — 代码与测试通过，但 `docs/install.md:145`（及 `:3`）仍宣称「普通会话不注入」，与同文件 `:191` 及生产行为直接矛盾；详见第 13 节。第 12 节保留为代码/测试核验记录。

第 1 轮曾判 APPROVE。新证据推翻了其中两条前提：① `tryMembership` 对任意 live root agent 返回隐式 `lead`（非"未组队即空串"）；② 因此测试里「非团队 root → 空串」只测了 mock，与生产语义相反。真实证据与阻断项见第 11 节。第 1-10 节保留为取证记录。

审查对象：`docs/root-cause.md`（task-1）、`index.js` 相对 `/tmp/index.js.orig` 的全部改动（task-2）、`tests/force-subagent.test.js` + `docs/verification-log.md`（task-3）、README/install 文档同步。
基线（实测）：`index.js` sha256 `9caff298…aa55ddf`，`/tmp/index.js.orig` sha256 `a31e38ee…0290c7e39`，测试文件 `b8e695eb…cc1ee6e0`。

## 1. 独立复跑（未引用 verifier 日志）

命令与结果（reviewer 本机直接执行，12:12 +08:00）：

```
$ node --test tests/
exit=0
ℹ tests 19
ℹ pass 19
ℹ fail 0
```

仓库无 package 构建步骤，Node v26.9.0（探针实测）。复跑前后 `index.js`/测试文件 sha256 未变，仓库未被审查过程修改。

## 2. diff 静态审查（`git diff --no-index -- /tmp/index.js.orig index.js`，exit 1，99 行）

逐 hunk 判定：

| 改动 | 位置 | 判定 |
| --- | --- | --- |
| 新增 `ORDER_ANCHOR = 'DEPLOYMENT_PERSONA_SUFFIX'`，`sectionOrder()` 查表锚点 +1；非有限值显式 `throw` | index.js:23、63-72 | 对因。不写魔法数，锚点缺失时 fail-loud（不静默降级），与 README 描述一致 |
| 新增 `resolveNudge()`：membership 有效→按 role；membership 为空且 `parentSession !== undefined`→teammate；否则空串 `not-in-team` | index.js:~40-56 | 对因。补齐 harness `roster.js:63-80` 对 subagent child 返回 `undefined` 的覆盖缺口（E5），并返回 `reason` 便于排障 |
| `apply` 内 `systemPrompt` 解构、`order: sectionOrder(systemPrompt)`、`text: () => resolveNudge(...).text` | index.js:91-97 | 正确；`text` 每轮求值不缓存（与 root-cause 机制第 3 点一致） |
| `NUDGES` 文案加「硬门禁：首个工具调用必须是 …」 | index.js:~16-19 | 内容增强，无逻辑副作用 |

未发现：硬编码返回值、针对测试输入的特判、空 `catch`、静默返回空值、TODO/FIXME、mock 逻辑混入实现、全局状态传递、类型逃避。`grep -nE "TODO|FIXME|catch|console.|process.env|setTimeout" index.js` → none。

## 3. 变异测试（证明断言有牙，均在 /tmp 副本执行）

副本基线：`cp -a` 后 `node --test tests/` exit=0，19 pass。

- **M1：`ORDER_ANCHOR` 改回 `'TEAM_POLICY'`（等价旧 601 行为）** → exit=1，`pass 13 / fail 6`。失败用例：`apply 回放已有 agent…`、`根因回归·位置：order 落在 DEPLOYMENT_PERSONA_SUFFIX 之后…`、`负例·锚点缺失…`、`agent/created…`、`生命周期…`、`重复 apply…`。
- **M2：删除 `parentSession` 回落分支（3 行）** → exit=1，`pass 17 / fail 2`。失败用例：`resolveNudge 对 membership 缺失 + 带 parentSession 的二级子代理注入 teammate 文案`、`subagent child：roster 无 membership 时回落 teammate…`。

结论：核心行为（落位、回落、回放、生命周期）均有可失败的实质断言，非恒真/空跑。

## 4. 负例真实性

- 非团队 root：测试 `非团队 root：text 为空串字符串且非 Promise，reason 为 not-in-team`（tests:359）断言严格空串 + 非 Promise + reason，实质。
- 未知 role：测试 `resolveNudge 对已注册但角色非法的 membership 返回 unknown-team-role…`（tests:168）与 `renderNudge 对未知/伪装/原型污染…严格空串`（tests:149），实质。
- 无 parentSession：测试 `resolveNudge 对 membership 缺失 + 根 agent（无 parentSession）返回 not-in-team`（tests:178），实质。
- 测试 11（tests:247-261）除等值断言外，还遍历 mock 的 `SECTION_ORDERS` 断言 `order > 每个已知 section`，并显式 `notEqual 601`——落位语义被真实约束，非只测 mock。

## 5. 挑战点结论

**(a) 「lead 已收到 nudge 却先跑 bash → 把 order 移到末尾」证据是否足够？**
**不足，属未证实假设。** E2 证明快照含 nudge（offset 4963 / 全长 15110，33% 处），E3 证明同轮首动作是 `bash` 且 reasoning 零命中团队词；这只能支撑「收到但没照做」，无法支撑「位置导致不照做」。root-cause.md 自身表述已克制（修复建议 #1 称 601 是「读到不执行」的「最可能放大器」，残留未知 #1/#2 明确承认无法观测注意力与采样差异），故**不构成 REJECT**；但报告与后续结论必须按「未证实假设」对待，不得宣称因果成立。风险：若真实原因是模型采样/文案权重而非位置，本次改动只是无害缓解，问题可能复发（8/30 可真实验证）。

**(b) `index.js:61` `parentSession !== undefined` 对 `parentSession: null` 的行为**
实测：

```
$ node --input-type=module -e "import {resolveNudge} from './index.js'; console.log(JSON.stringify(resolveNudge(undefined,{session:{header:{parentSession:null}}})))"
{"role":"teammate", ... "reason":"subagent-child"}
# 同参数 parentSession 缺省时 → {"text":"","reason":"not-in-team"}
```

判定：**兜底语义不严，会让 null 误判为 subagent-child（fail-open）**。但 harness 有类型不变量：`parentSession` 存在时必须是 string，否则抛错（`packages/core/session/lib/types/index.js:52-53`），且仅活跃子会话写入（同文件 :1198）。因此经受支持路径不可能出现 `null`。
**严重度：低。值得修：是（一行 `typeof === 'string'` + 一条负例），但不阻断本次合并。**

## 6. 非阻断缺陷卡片

| ID | file:line | 问题 | 复现 | 期望 / 实际 | 修复要求 |
| --- | --- | --- | --- | --- | --- |
| F1 | index.js:61 | `parentSession: null` 误判为 subagent-child | 上文 node 单行命令 | 期望 `not-in-team` + 空串；实际 `subagent-child` + teammate 文案 | 改 `typeof agent?.session?.header?.parentSession === 'string'`，补 `parentSession: null` 负例 |
| F2 | docs/root-cause.md（最小修复建议 #1） | 推荐 `order: 20000` 魔法数，与最终实现 `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1` 不一致 | 阅读文档 | 期望文档与实现一致；实际文档推荐已废弃写法 | 改为锚点方案并注明「实现已采用锚点，禁止魔法数」 |
| F3 | docs/root-cause.md 结论段 | 未显式标注「位置→遵从」为未证实假设 | 阅读结论与残留未知 | 期望显式标注；实际仅有「最可能放大器」措辞 | 在结论处加「假设（未证实）」标记，避免被引用为因果定论 |

## 7. 残余风险

1. 位置修正对遵从率无 A/B 证据；仅能靠后续真实会话观察。
2. 普通 subagent（非 roster）拿到 teammate 文案属设计选择（E5），若模型将其误解为「必须再派发」可能造成过度委派；文案已限定深度 ≤2，风险可控。
3. `order = 锚点+1` 依赖 harness 常量表「`DEPLOYMENT_PERSONA_SUFFIX` 为最后一项」；该表新增更大 order 的 section 时 nudge 会再次被埋，无自动检测。
4. 测试对 `SECTION_ORDERS` 的 mock 表与 harness 常量表为手工同步，未来 harness 改值而 mock 未改时，测试仍绿。

## 8. 未完成项（风险已知）

- ~~用当前 lead 会话 jsonl 佐证「nudge 已位于新提示词末尾」~~：**已由交付后复核补齐**，见第 10 节（11:18:40 快照 nudge 位于最后 255 字符）。
- 未独立复现 task-1 的 projcache/zstd 全套取证命令（只核对了结论与 file:line 引用的存在性）；交付后复核已抽查其中 6 项（见第 10 节）。
- 4 个审查 subagent（静态/复跑/断言/运行时）在 30+ 分钟内均未返回结果（与 root-cause.md 记录的同一路由故障一致）；存活探针成功。为守时间盒，上述复跑、diff、变异、null 探针由 reviewer **DIRECT** 执行并原样记录命令与输出。
- 报告交付后，限时微验证 subagent 返回并独立复现同一结果：`sha256sum` 与基线一致、`node --test tests/` EXIT=0（19/19）、`git diff --no-index` DIFF_EXIT=1（99 行，改动内容与第 2 节一致）。结论不变。

## 9. 交付后复核（独立 subagent，不改变结论）

另一复跑 subagent 在副本 `/tmp/review-mut1/2`、`/tmp/review-neg1..neg5` 独立复核，结果与第 3、4 节一致并补充了负例反转证据：

- 基线：sha256 同上，19/19、exit 0；副本先跑通原测试再变异。
- M1（`ORDER_ANCHOR` → `'TEAM_POLICY'`）：exit 1，pass 13 / fail 6，失败用例与第 3 节逐条相同，栈 `actual: 601, expected: 10201`。
- M2（`parentSession !== undefined` → `false`）：exit 1，pass 17 / fail 2，失败用例同上；两条 not-in-team 负例仍 pass，说明变异定位准确、无误伤。
- 负例反转：非团队 root 断言反转 → fail 1；未知 role 断言反转 → fail 1，去掉 `Object.hasOwn(NUDGES, role)` 守卫 → fail 5（含原型污染用例）；无 parentSession 断言反转 → fail 1，root 改为注入 teammate → fail 3。
- 仓库完整性：结束后 sha256 与基线一致，变异仅存在于 /tmp 副本；测试直接 import 真实 `{inject, renderNudge, resolveNudge, apply}`，未见恒真断言。

结论（第 1 轮）：`VERDICT: APPROVE`。已被第 11 节推翻。非阻断卡 F1-F3 维持。

## 10. 交付后运行时复核（补齐第 8 节未完成项）

只读取证，未改文件、未重启服务。宿主重启后 PID 4040148，`ps lstart` = 2026-10-30 11:17:34。

```
f=~/.dsh/sessions/--home-csy-Work-twoplus--/session-a77c0d43-e871-4691-8926-42b7f9af4b91/session.v4.jsonl.zstd
zstdcat $f | jq -r 'select(.type=="system/message") | .data.message.content[0].text as $p |
  [$p|length, ($p|index("用户提示已到达")), (($p|length)-($p|index("用户提示已到达")))] | @tsv'
```

| 快照时间 | 全长 | nudge 起点 | 其后字符 | 判读 |
| --- | --- | --- | --- | --- |
| 10-29 17:17 / 17:31 / 17:50 | 13843 / 13972 / 14953 | null | — | 插件未装，无 nudge |
| 10-30 10:38:57（失败当轮） | 15110 | 4963 | 10147（33%） | 旧 order=601 |
| 10-30 11:12:04（重启前） | 14129 | 4963 | 9166 | 旧行为 |
| **10-30 11:18:40（重启后）** | **14229** | **13974** | **255** | **末尾，紧接 DEPLOYMENT_PERSONA_SUFFIX 之后（order 10200+1 生效）** |

- 其它重启后 lead 会话：`718a1dc3`（11:18:35）、`6473747b`（11:18:48，nudge 距末尾 221 字符）均为同一落位。
- 二级子代理（parentSession 非空，如 `24b235c9`、`33a8dc1e`）快照末尾 122 字符 = teammate 文案 → 回落分支真实生效。
- 反向对照：重启前 `338226ce`、`54515897`、`ba13c231` 仍为 4963/3199 起点，证明位置变化来自本次修复。
- 插件加载：`~/.dsh/logs` 最新文件为 2026-10-12（文件层无证据）；`journalctl _PID=4040148 --since "2026-10-30 11:17:30" --until "2026-10-30 11:19:30"` 仅 4 条失败（lsp / lsp-stdio / lsp-tool / hooks-claude-code 的 `ERR_MODULE_NOT_FOUND`），不含本插件；无 apply 报错、无 section 撞名、无 getSectionOrder 抛错 → **加载成功已证实**。
- 与 root-cause.md 交叉核对：会话建立时间/cwd、三次无 nudge 快照、E2 偏移、w7 与 reviewer 快照、软链与 package.json、旧 host 启动时间共 6 项一致。**一处需修正**：root-cause.md:135「拿不到加载与报错」只对 `~/.dsh/logs` 成立，journald 可证。见 F4。

**F4（非阻断，文档）**：`docs/root-cause.md:135` 的「cordis 加载证据」表述过宽 → 应改为「`~/.dsh/logs` 无证据；journald 可证加载成功且无 apply 报错」。

运行时复核后仍不可观测的：模型是否「读到」nudge（注意力层面），故第 5(a) 节「位置→遵从属未证实假设」结论不变。本节结论属第 1 轮，已被第 11 节推翻。

## 11. 第 2 轮：推翻 APPROVE

触发：静态审查 subagent 指出 `tryMembership` 存在隐式 lead 分支；reviewer 独立复跑源码与会话 jsonl 后确认。

### 11.1 机制（源码已核）

- `roster.js:64`：`this.ctx.agents.get(agent.id) !== agent → undefined`（仅 stale 身份）。
- `roster.js:78-80`：`parentSession` 存在、但不在 durable roster、且无 `subagentDescriptor` 的普通 fork → `{ role: 'lead' }`。
- `roster.js:87-89`：live、无 `parentSession`、无 `subagentDescriptor` 的 root → `{ role: 'lead' }`。

结论：**对 live root agent，`tryMembership` 几乎从不返回 `undefined`**。插件的 `not-in-team` 分支在生产中只剩 stale 身份与 descriptor 子代理两类，README/index.js 注释所称「未组队 root → 空串」不成立。

### 11.2 真实会话证据（非 mock）

```
j=~/.dsh/sessions/--home-csy-Code-installer-deepseek-harness--/session-338226ce-a2d2-45c6-8c5e-aedea7c103b0/session.v4.jsonl.zstd
zstdcat $j | jq -r 'select(.type=="system/message") | [.time, (.data.message.content[0].text|length), (.data.message.content[0].text|index("用户提示已到达"))] | @tsv'
# 1793329059166  15110  4963   (≈10:57:39)
# 1793329856025  14129  4963   (≈11:10:56)
```

- 该会话 `grep -c '"parentSession"'` → **0**；`.type` 中 **无任何 `team/*` 记录**；`tool/call` 中 **无 `team_*` 工具**（仅 bash×62、edit×2、read、skill、list_agents、mcp×6）；cwd=`/home/csy/Code/installer/deepseek-harness`。
- 快照偏移 4963 处为 **lead 文案原文**「用户提示已到达。本会话启用了 Agent Teams：不要独自实现…」（旧版文案，order=601 时代）。
- 结论：**未组队 root 会话被注入了 lead 硬门禁 nudge**。这是既有行为（基线同样调用 `tryMembership`），diff 未引入，也未修复。

对照：`718a1dc3`（cwd `vss.b12s3.dsp`）有 31 条 `team/*` 记录、13 次 `team_*` 调用，属真团队会话；但插件对它与 `338226ce` 拿到的 membership **同为 `role:'lead'`**，无法区分。

### 11.3 阻断项

**B1（阻断）：文档与生产行为相反，且测试无法证伪。**
- 涉事位置：`README.md:15`「其余（未组队 root agent）→ 空串」、`docs/install.md:191`「普通会话无注入属预期」、`index.js:41-47` 注释。
- 测试盲区：`tests/force-subagent.test.js:79-84` 整体 mock `tryMembership`；`tests:359-374`「非团队 root」只验证「membership 为 undefined 时插件返回空串」，而该输入在真实 roster 下不可达 → 结论「普通会话不注入」是**未经验证的口头承诺**。
- 修复要求（二选一，须显式决策并同步代码/文档/测试）：
  - **方案 A（推荐，保持插件核心用途）**：承认「agentTeams 服务已加载的 profile 中，所有 root agent 都是隐式 lead」→ 修正 `README.md:15`、`docs/install.md:191`、`index.js` 注释；把「非团队 root」用例改名为「root + 隐式 lead → lead 文案」并用 `{role:'lead'}` 输入断言；删除「未组队 root → 空串」表述。
  - **方案 B（团队专属）**：仅当存在显式团队启用信号时采纳 `role==='lead'`。**不得**用「durable team records 非空」作信号——turn 0 的新 team lead 尚无任何记录，会把插件的核心场景（首轮强制建团队）关死；需新增显式配置/开关，并补真实 roster 语义回归用例。
- 注意：静态审查 subagent 建议的「仅当有 team 记录才采纳 lead」会破坏首轮注入，不采纳为默认修法。

**B2（阻断，同 commit 一并修）：** `docs/root-cause.md:33-34` 把 `tryMembership` 描述为「否则 undefined」，漏掉 `roster.js:78-80/87-89` 隐式 lead 分支——这是 B1 的机制性文档错误，须修正。

### 11.4 非阻断项（第 2 轮补充）

- `tests:233` `assert.equal(s.spec.text instanceof Promise, false)` 为恒真冗余（函数不可能是 Promise），删除；`tests:236/368` 已断言 `text()` 返回值。
- `tests:272` 以 `/cannot place section/` 正则耦合 `index.js:77` 错误文案，建议改为断言锚点名 + SECTION_NAME。
- `docs/verification-log.md:97` M1 只写「fail」未给计数，实测 **fail 6**，缺 5 个命中；`:110`「10201 > 全表」实际只对比 3 项 stub 表，措辞应改为「> stub 表全部条目；10200 为 harness 实测最大」。
- `docs/root-cause.md:135`「拿不到加载与报错」仅对 `~/.dsh/logs` 成立，journald 可证（F4）。
- F1（`parentSession: null`）复核后降级：方向是误注入 teammate 文案，但 harness 强制该字段为 string（`session/lib/types/index.js:52-53`），运行时不可达；建议顺手改 `!= null` + 补用例，不阻断。
- 位置修正对遵从率仍无 A/B 证据；且存在反证（旧 order 下用户手动 `/team-recursive-orchestration` 后 lead 即刻照做），第 5(a) 节「未证实假设」维持，修复只能算无害缓解。

### 11.5 第 2 轮结论

**`VERDICT: REJECT`**。实现核心（order 末尾、resolveNudge、锚点 throw、每轮求值）经复跑与变异证明有效，但「非团队 root 不注入」的事实性宣称与生产行为相反，且负例测试建立在不存在的 mock 语义上。需按 B1/B2 修正并经复核后重新提交（剩余对抗轮次：1）。

## 12. 第 3 轮复核（最终）：B1/B2 已修 → APPROVE

### 12.1 可执行代码递归核查（Lead 指定）

- 当前 `index.js` sha256 `31060040…2da677be`；上轮 `9caff298…aa55ddf`。
- 从 `/tmp/rm1` 副本回滚 `ORDER_ANCHOR` 后复算 sha256 = `9caff298d2695375…aa55ddf`（与上轮逐字节一致），作为对照基线 `/tmp/prior-check.js`。
- `git diff --no-index -- /tmp/prior-check.js index.js`：24 行差异，**全部为 `*` 开头的 JSDoc 行**；过滤注释/空行后变更行数 = **0**。
- 非注释新增行（vs `/tmp/index.js.orig`，`--unified=0`）= **29**，与上轮口径一致。
- 结论：**「仅改 JSDoc」成立**，无可执行逻辑混入。

### 12.2 独立复跑

```
$ node --test tests/
exit=0；ℹ tests 19 / pass 19 / fail 0
```

### 12.3 B1 核验（已修）

- `README.md:12` 角色表改为「`lead` / 隐式 lead」，写明 `roster.js:87-89`；「其余」行改为仅在 host 未加载 `agentTeams`、stale（`roster.js:64-65`）、journal 异常（`roster.js:91-96`）时为空串。
- `docs/install.md:191` 改为「本 profile 对所有 root 会话注入 lead nudge……仅 `agentTeams` 缺失时插件不加载」。
- `index.js:40-58` JSDoc 三分支同步（隐式 lead / descriptor child 回落 / stale 空串）。
- `tests:59` 注明旧「非团队 root」正向用例已删除；`tests:383` 新用例「隐式 lead（生产可达）」断言 `rosterLikeMembership(root)` 返回 `{role:'lead'}`、`text()` 等值 `renderNudge('lead')`、含硬门禁、不含 teammate 文案；`not-in-team` 仅作纯函数防御边界（注释标明生产不可达）。
- 变异核验（`/tmp/rm3`）：`rosterLikeMembership` 改为 `return undefined` → exit 1，**pass 17 / fail 2**，失败含该新用例与 `apply 回放已有 agent…` → 新断言有牙。

### 12.4 B2 核验（已修）

`docs/root-cause.md:33` 判定链完整且与 `roster.js:63-96` 一一对应：stale → `undefined`（:64-65）；有 `parentSession`：roster member 且 `phase ∈ {active, provisioning}` → `teammate`（:71-73），descriptor child → `undefined`（:78-79），普通 fork → 隐式 `lead`（:80）；无 `parentSession`：descriptor child → `undefined`（:87-88），root → 隐式 `lead`（:89）。同段附 `session-338226ce` 实证，并保留「位置→未遵从是未验证假设」声明。

### 12.5 非阻断残留

| 项 | 现状 | 判定 |
| --- | --- | --- |
| `tests:290` | 仍用 `/cannot place section/` 耦合错误文案 | 措辞脆弱，建议改断锚点名；不阻断 |
| `docs/verification-log.md:112` | 仍写「10201 > 全表」 | 结论对、措辞过强；不阻断 |
| 测试内 `rosterLikeMembership` | 为 harness 语义的手写镜像（未 import） | roster 变更需人工同步；已有行号注释，风险可接受 |
| 位置→遵从 | 仍无 A/B 证据，存在反证 | 已按「未证实假设」标注；修复属无害缓解 |
| `parentSession: null` | 仍不可达（harness 强制 string） | 建议顺手 `!= null`；不阻断 |

本轮未发现新糊弄：无硬编码返回值、无空 catch、无静默降级、无新增过度 mock；新增测试数据为显式标注的生产语义镜像，且经变异证明可失败。

### 12.6 第 3 轮结论

**代码/测试核验通过**：第 2 轮阻断项 B1/B2 已实质修复；可执行代码零变更（仅 JSDoc），19/19 真实通过，隐式 lead 用例经反向变异失败证明有效。
（12.6 曾据此判 APPROVE；交付后发现 `docs/install.md:145/:3` 残留同一声明矛盾，最终裁决改为 **REJECT**，见第 13 节。）

## 13. 第 3 轮最终裁决：REJECT（文档自相矛盾）

### 13.1 阻断项 B3：install.md 内部自相矛盾

同一文件两处表述直接冲突：

- `docs/install.md:191`（本轮已修）：「本 profile 加载了 `agentTeams`，因此插件对该 profile 下**所有 root 会话注入 lead nudge**」。
- `docs/install.md:145`（未修）：「重启后，用新的 agent-team 会话验证注入是否出现；**普通会话不注入属预期**。」
- `docs/install.md:3`（未修）：「非 agent-team 会话不注入。」

复现：
```
$ sed -n '3p;145p;191p' docs/install.md
```

期望：全文件一致表述「`agentTeams` 已加载的 profile 中所有 root 会话都会注入 lead nudge；仅未加载 `agentTeams` 的部署不加载插件」。
实际：`:145` 与 `:3` 仍宣称普通会话不注入，与 `:191` 及实测（session `338226ce` 无 team 记录仍注入 lead 文案）相反。用户按 `:145` 做重启后验证会得出错误结论——这正是第 2 轮 B1 的同一类缺陷，故未修复完整。

修复要求（1 处两行）：
- `docs/install.md:145` 改为「重启后，任意新会话的 root agent 都应出现 lead nudge；若未出现，先确认 host 已重启且 profile 加载了 `agentTeams`」。
- `docs/install.md:3` 改为「未加载 `agentTeams` 的部署不加载本插件」。

### 13.2 非阻断残留（维持第 12.5 节判定）

- `docs/verification-log.md:112`「10201 > 全表」措辞未改（应为「大于 stub 表既有条目；10200 为 harness 实测最大」）。
- `tests:290` `/cannot place section/` 仍耦合 harness 错误文案（C 级；Lead 已列为非阻断）。
- `index.js:8` 文件头「非团队成员渲染空串」未点出 root 隐式 lead（表述歧义，非错误）。
- `docs/root-cause.md:71-73` 的 teammate 分支行号实际为 `roster.js:72-73`（偏 1 行，可忽略）。

### 13.3 最终结论

**`VERDICT: REJECT`**。代码、测试、根因机制均已通过第 12 节核验；唯一阻断为 `docs/install.md` 残留的「普通会话不注入」自相矛盾表述（两行）。按协议本轮为第 3 轮，停止对抗，交 Lead 仲裁：建议由 implementer 改这两行后直接交付，无需再复审代码。

## 14. Lead 仲裁与交付状态

### 14.1 B3 已修复（reviewer 实测复核）

implementer 于 12:53 修正 `docs/install.md` 两行。复核命令与实测输出：

```
$ sed -n '3p;145p;191p' docs/install.md
:3    在 Agent Teams 会话中按角色注入强制委派提示：…；未加载 `agentTeams` 的部署不加载本插件。
:145  重启后，任意新会话的 root agent 都应出现 lead nudge；若未出现，先确认 host 已重启且 profile 加载了 `agentTeams`。
:191  - **注入范围**：本 profile 加载了 `agentTeams`，因此插件对该 profile 下**所有 root 会话注入 lead nudge**…（未改动）

$ grep -nE "非 agent-team|普通会话不注入" docs/install.md README.md index.js ; echo exit
# 无输出，exit=1（零残留；仅本报告正文保留历史引用）
```

三处口径一致：root → 隐式 lead 注入；stale / descriptor child / 未加载 `agentTeams` → 空串。B3 关闭。

### 14.2 仲裁结论

- 第 3 轮为对抗上限（3/3）。
- Lead 裁决：接受上述两行修正后交付，不再开第 4 轮。
- 第 13 节的 `VERDICT: REJECT` 作为历史记录保留，顶部结论行按 Lead 要求不改写。

### 14.3 最终交付状态

| 项 | 状态 |
| --- | --- |
| `index.js` | sha256 `31060040…2da677be`（相对上轮 `9caff298…` 仅 JSDoc，非注释变更 0） |
| `node --test tests/` | exit 0，tests 19 / pass 19 / fail 0（reviewer 本次复跑） |
| install / README / root-cause | 口径一致（隐式 lead 语义 + 位置假设标注） |
| 阻断项 | 无（B3 已修） |
| 已知遗留（不阻断） | verification-log:112「10201 > 全表」措辞；tests:290 `/cannot place section/` 耦合；index.js:8 头注释歧义；root-cause.md:71-73 行号偏 1；`parentSession:null` 防御；位置→遵从无 A/B 证据 |

