# 审查报告：审查代码模型（reviewer 路由）+ 内置 skills 收编

审查员：`reviewer`（独立对抗审查）
被审查改动：工作区未提交改动（`git status` / `git diff` 取证，基线 `8e9d60c`）
取证时间线（关键事实，因为本轮有成员并行修改 `index.js`）：

| 事实 | 时间戳 / 证据 |
|---|---|
| `index.js` 最终状态 | `stat` → `2026-11-18 12:53:47`（审查过程中该文件从 2008 行增长到 2014 行，label 判据被并行修改） |
| `tests/model-route-config.test.js` 最终状态 | `2026-11-18 12:53:16` |
| 我读到的**修复前**快照 | `index.js:289` 当时存在非锚定 `REVIEWER_LABEL_PHRASE_RE = /\bcode[\s_-]+review(?:er)?\b/i`，实测三条实现类 label 全部误判为 `true` |
| 我读到的**修复后**终态（本报告结论基于终态） | `index.js:291/295`，`grep -c "REVIEWER_LABEL_PHRASE_RE =" index.js` → `0`；实测样例全对 |

## 0. 取证方法

- `git status --porcelain` / `git diff --stat` 逐文件确认改动面（25 个已跟踪文件 + 新增 `skills/`、`tests/skills-provider.test.js`、`tests/save-all-workspaces.test.js`）。
- 契约核验一律**亲自执行**：`node --input-type=module -e` 直接调用 `index.js` 导出的 `resolveConfig` / `isReviewerActivation` / `createPackagedSkillProvider`，用真实磁盘与真实导出值取证，不看注释。
- 宿主契约一律回宿主源码核对：`/home/csy/Code/installer/deepseek-harness-0.2.2-rc.2/packages/skill/skill/src/index.ts`、`packages/skill/skill-filesystem/src/index.ts`（给路径:行号）。
- 测试真实性：亲自跑 `node --test tests/*.test.js`（两次，见 §6），并做**变异反证**（§6.2）证明关键不变式测试不是恒真。
- 说明：本工作区的 vectr MCP 工具不可用（`vectr_status` → `unknown tool`，`vectr_search` → `Internal Server Error`），按检索回退链降级到 grep + read，全部结论都有行号或实测输出。

---

## 1. 逐契约核验

### 契约 1：配置与归一化 —— **通过**

| 断言 | 证据 |
|---|---|
| `optionalRouteSchema` 两段默认空串（与 `routeSchema` 的唯一区别） | `index.js:44-47`（`routeSchema` 用 `DEFAULT_ROUTE`）/ `index.js:54-57`（`optionalRouteSchema` 用 `''`） |
| `Config.reviewer` / `workspaceSchema().reviewer` | `index.js:84`、`index.js:62`，都是 `optionalRouteSchema().default({ provider: '', model: '' })` |
| `DEFAULT_CONFIG` 不含 `reviewer` | `index.js:42`：`{ enabled, mode, member, subagent, workspaces }` |
| 仅 provider+model 都非空才挂 `reviewer` | `index.js:121-135`（`optionalRoute`：`provider.length===0 && model.length===0 → undefined`；单段空 → `undefined` + warn）、`index.js:162-163`（工作区）、`index.js:175-176`（全局） |
| 半残 warn-once 且按**配置位置**去重 | `index.js:112`（`warnedReviewerConfig` Set）、`index.js:128-131`；location 由 `index.js:162` 构造成 `workspaces["/w"].reviewer`，`index.js:175` 构造成 `reviewer` |
| 不透传残缺路由 | 实测（下方输出）`reviewer in result = false` |

实测输出（`node --input-type=module -e`，逐条对应上表）：

```text
OK resolveConfig({}) / (undefined) deepEqual DEFAULT_CONFIG; reviewer in result = false
OK both-empty => reviewer in result = false
half config warns count = 1 => 可选路由 reviewer 只配置了一半（provider="p"、model=空），整条已忽略，…
half config result reviewer in? false
workspace half warns count = 1 => 可选路由 workspaces["/w"].reviewer 只配置了一半（provider=空、model="m"），…
full => {"provider":"pv","model":"mv"} {"provider":"pw","model":"mw"}
full.enabled/mode/member keys preserved => enabled,mode,member,subagent,workspaces,reviewer
```

`assert.deepStrictEqual(resolveConfig({}), DEFAULT_CONFIG)` 与 `resolveConfig(undefined)` 均通过；半残配置重复解析 3 次只告警 1 次。

### 契约 2：路由与注入 —— **通过**

- `resolveRoute` 同一口径处理三类：`index.js:270-275` —— `settings.workspaces[key][kind]` 存在即用，否则 `settings[kind]`；`settings` 缺失一律 `undefined`（调用方 fail-open）。reviewer 两级都没有 → `undefined`（`index.js:267-268` 注释与实现一致）。
- `installTeamMemberRoute` 的 `baseKind` / `kind` / `route`（`index.js:1887-1892`）：

```js
const baseKind = isMember ? 'member' : 'subagent'
const reviewerRoute = isReviewerActivation(spec, request)
  ? resolveRoute(live, workspaceKey, 'reviewer')
  : undefined
const kind = reviewerRoute !== undefined ? 'reviewer' : baseKind
const route = reviewerRoute ?? resolveRoute(live, workspaceKey, baseKind)
```

  `reviewerRoute === undefined` 时 `kind === baseKind`、`route === resolveRoute(live, key, baseKind)`，与改动前逐字等价（`git diff` 中该分支只有这两行新增，`resolveRoute` 本体未动）。
- 顶层 `agentOptions` 注入 + 无条件删 `reasoningEffort`：`index.js:1893-1899`（`agentOptions = { ...(request.agentOptions ?? {}), provider, model }` 后 `delete agentOptions.reasoningEffort`）。
- 入参不被就地修改：`index.js:1903` `nextSpec = { ...spec, agentOptions }`；嵌套形状双写：`index.js:1905` `nextSpec = { ...nextSpec, request: { ...request, agentOptions } }`。测试 `F4`/`RF1`/`RF4` 用 `assert.notEqual(seen.agentOptions, callerOptions)` + `assert.deepEqual(original.agentOptions, callerOptions)` 直接证明（`tests/team-model-route.test.js:599-600`）。
- 包裹防叠加 + 可回滚：`index.js:1838-1843`（`ROUTE_WRAPPED` 已包裹则跳过并 warn 一次）、`index.js:1917-1926`（`wrapped[ROUTE_WRAPPED]=true`；disposer 只 `delete` 自有影子属性，注释给出真实探针结论 `c6_ownPropertyAfterDispose=true`）。测试 `h)`（`tests/team-model-route.test.js:314-341`）断言 dispose 后落到原实现、重复 apply 不叠加。
- 向后兼容：`RF3`（`tests/team-model-route.test.js:623`）+ `resolveRoute：两级 reviewer 都没配时 reviewer 是 undefined；member / subagent 行为完全不变`（`tests/workspace-route.test.js`，我在 §6 的运行日志里看到该用例逐条通过）。

### 契约 3：识别口径 —— **通过（缺陷已由并行修复闭环，我独立复核）**

**我亲自复现的修复前缺陷**（12:47 快照，`index.js:289` 当时为非锚定短语正则）：

```text
FAIL label="修复 code review 面板的崩溃" => true (want false)
FAIL label="实现 code review 能力"      => true (want false)
FAIL label="给 code-review 加个按钮"     => true (want false)
```

**终态复核**（`index.js:291/295`，`grep -c "REVIEWER_LABEL_PHRASE_RE =" index.js` → `0`）：

```text
OK   "修复 code review 面板的崩溃" => false      OK   "code review"        => true
OK   "实现 code review 能力"       => false      OK   "code-review"        => true
OK   "给 code-review 加个按钮"      => false      OK   "reviewer"           => true
OK   "修复 code review 的 bug"      => false      OK   "审查代码" / "代码审查" / "对抗审查" => true
OK   "implement code review feature"=> false     OK   "review impl"        => true
OK   "实现审查代码模型"             => false      OK   "please review"      => true
OK   "修复代码审查bug"              => false      OK   "审查一下这段代码"    => false
OK   "审查"                        => false      OK   "implement review model fix" => false
mismatches = 0        (18 条样例全对)
```

三段判定与"绝不回落"也实测成立：`name='worker' label='审查代码'` → `false`；`name='code-impl' label='code reviewer'` → `false`；`name='' preset='reviewer' label='修复崩溃'` → `true`；`{}` → `false`。
`description` 从不参与：`index.js:304-317` 只读 `spec.name` / `request.agentPreset` / `spec.label`；全文件 `grep -n description index.js` 只出现在 skills frontmatter（`1239/1245`）与命令元数据（`1982/1995`），不在注入路径。

变异反证（证明测试不是配合实现写的）：把旧短语正则与实现类 wrapper 组合（5 词组 × 9 句式 = 45 条 label）离线跑：

```text
{ total: 45, oldMatches: 36, newMatches: 0 }
```

即旧实现下 `R14` 会红 36 条，现实现 0 条 —— 判据确实被锚定，不是把测试改成迁就实现。

### 契约 4：留痕可观测性 —— **通过**

- 相等即早退（零 warn 零 notice、注入照常）：`index.js:1812`（`if (sessionModel.provider === route.provider && sessionModel.model === route.model) return`），且 `observeRouteOverride` 在 `nextSpec` 组装**之后**才调用（`index.js:1903-1908`），早退不会取消注入。
- 恰好一次 warn + 一条 notice：`index.js:1826-1830`；notice 前缀 `[team-gate] MODEL_OVERRIDE:`。
- 去重键含 `kind`：`index.js:1813` `const routeKey = \`${kind}|${route.provider}/${route.model}\``，`index.js:1813-1819` WeakMap<会话, Set>；notice key `model-override:${routeKey}` 同样含 kind。
- 两级未配置时 kind 不冒充：`kind` 只在 `reviewerRoute !== undefined` 时才是 `'reviewer'`（`index.js:1891`），`KIND_LABEL` 只在真 reviewer 时输出「审查代码」（`index.js:1801-1802`）。测试 `R23` 断言 `warns[0]` 含「成员」且**不含**「审查代码」（`tests/route-override-observability.test.js:627-628`）。
- 读不到会话模型不比较不告警：`index.js:1808-1811`；`R5`/`R6`/`R7` 覆盖；logger 抛错有兜底计数而非空 catch（`index.js:1786-1795`）。

### 契约 5：内置 skills provider —— **通过**

实测（真实磁盘、真实导出，无 mock）：

```text
root = /home/csy/Code/Github/dsh-force-subagent/skills
count = 4
team-adversarial-gatekeeper | rank 550 | source custom | provider dsh-force-subagent | inv {"modelInvocable":true,"userInvocable":true}
team-lead-delegation        | rank 550 | source custom | provider dsh-force-subagent | inv {...true,true}
team-parallel-dispatch      | rank 550 | source custom | provider dsh-force-subagent | inv {...true,true}
team-recursive-orchestration| rank 550 | source custom | provider dsh-force-subagent | inv {...true,true}
get name= team-adversarial-gatekeeper resourceBase= {"kind":"directory","path":".../skills/team-adversarial-gatekeeper"}
list leaked body? false      errors: 0      provider name = dsh-force-subagent
```

- 真实读盘：`index.js:1256-1281`（`readdir` + 每目录 `readFile`）、`index.js:1215-1230`；`index.js:22` 是全仓唯一的 `node:fs` 导入，且只 `readdir, readFile`（只读）。
- `list()` 只出 frontmatter、正文留到 `get()`：`index.js:1255` 注释与实现一致；候选对象无 `content`（实测），`index.js:1304` 才带 `content: parsed.body`。
- 宿主契约核对：`SkillResourceBase` 的 `{ kind:'directory', path }` = 宿主 `packages/skill/skill/src/index.ts:43-44`；`SKILL_NAME` 语法 = 宿主同文件 `:21`（与 `index.js:1185` 逐字一致）；`SkillInvocationPolicy` = 宿主 `:49-53`；`registerProvider(create): () => void` 返回注销器 = 宿主 `:390`。
- 降级/错误口径：`skills` 服务缺失安静返回（`index.js:1325`、`index.js:1352`）；`ENOENT` 静默（`index.js:1262`）、`ENOTDIR` 等真实错误 warn-once（`index.js:1189` + `index.js:1212-1218` 的 `warnSkills` 去重）。测试 `190/204/238/248/271` 逐条覆盖。
- 注销器真挂到 scope/effect：`index.js:1329-1335`（`child.effect(() => dispose, 'force-subagent:skills provider')`）、退化路径 `index.js:1354-1358`。测试 `281` 断言 `service.effects.length === 1`、dispose 后 `providers.length === 0` 且 `listAll()` 为空、重复 dispose 幂等、正常路径零告警。
- `registered` 不谎报：`index.js:1321-1342`，`providerRegistered` 只在 `registerProvider` 成功后置真；注入未执行 / 服务缺失 / 注册抛错一律 `false`（测试 `314/331/341/352`）。

### 契约 6：客户端 —— **通过**

- `buildDraft` 六字段：`client.js:196-208`。
- 两个 mutation 都写 `reviewer`、不污染入参、保留其它工作区与额外字段：`client.js:211-227`（`buildWorkspacesMutation`）、`client.js:246-263`（`buildAllWorkspacesMutation`），两者都先 `Object.keys(source)` 复制、再逐条目复制原字段后才覆盖三张路由。测试 `tests/client-ui.test.js:328-345` 断言入参 `current['/a'].reviewer.provider === 'keep'`、`extra: 'keep'` 保留。
- `draftIsValid` / `invalidRouteLabel` 三组成对且点名是哪张卡：`client.js:292-296`（`ROUTE_GROUPS` 含 `label: '审查代码模型'`）、`client.js:299-320`。测试 `tests/client-ui.test.js:445-456`：`invalidRouteLabel({..., reviewerProvider:'r'}) === '审查代码模型'`。
- 第三张卡存在、`emptyHint` 文案正确、`inherited.reviewer` 已配时显示「留空则继承全局默认：p/m」：`client.js:1257-1264` + `client.js:1415-1416`（`'留空则回退到成员 / 子代理路由'`）。渲染级测试 `tests/client-ui-behavior.test.js:540-578` 断言 `'留空则回退到成员 / 子代理路由'` 与 `'留空则继承全局默认：gp / gm'` 逐字相等；元素 id 由 `client.js:1291-1294` 生成为 `fsx-reviewerProvider` / `fsx-reviewerModel`，与 `docs/DELIVERY.md:57` 的说法一致。
- `buildModelOptions` 向后兼容旧签名且不泄漏 reviewer 候选：`client.js:417-421`（`routesOf(source.current).concat(routesOf(source.currents))`，单对象与数组都吃）；候选构造 `client.js:969-980` —— 成员卡/子代理卡只传各自单对象，审查卡才传 `[draft.reviewer, inherited.reviewer]`。测试 `tests/client-ui.test.js:282-316`（旧签名不破）、`tests/client-ui-behavior.test.js:664-682`（审查下拉 `['','dp','gp']`，成员卡必须 `['','dp']`）。

### 契约 7：测试真实性 —— **通过**（详见 §6）

### 契约 8：文档一致性 —— **发现 1 处不符（缺陷 D1）+ 1 处口径不完整（缺陷 D2）**，详见 §5 与缺陷卡片。

### 契约 9：skills 正文 —— **通过**

`diff -U0 ~/.dsh/skills/<name>/SKILL.md skills/<name>/SKILL.md` 逐文件比对，只有 rc.2 工具名与模型口径的行被改，铁律全部保留：

| 技能 | 相对原件的改动 | 是否伤及铁律 |
|---|---|---|
| `team-adversarial-gatekeeper` | 仅 2 行（`@@ -47`、`@@ -74`）：拉起审查员改为 `subagent` + `name:"reviewer"`；打回返工措辞加「看板」 | 否。强拒绝偏置 Prompt、严打清单①②③④、`VERDICT: APPROVE/REJECT` 格式、最多 3 轮均未改动 |
| `team-lead-delegation` | 5 行：`team_task_create` → `todo_write` 看板、`spawn_teammate` → 批量 `subagent`、思考强度档位 → 插件路由 | 否。「细节任务一律委派」「严禁 Lead 下场」等条目原文保留 |
| `team-parallel-dispatch` | 描述行 + 批量派发/看板/Pull-based 段落 + 模型段 | 否。批量派发、互斥 `write_scopes`、事件驱动等待、禁止空转轮询均保留 |
| `team-recursive-orchestration` | 3 行：禁止再派发、例外直做补 rc.2 flat 口径、模型分配改插件路由 | 否。深度 2 层封顶、`DIRECT: <原因>` 标注、反模式表保留 |

- `grep -c spawn_teammate skills/*/*.md` → 全部 `0`。
- frontmatter 合法：4 个文件均为 `---` / `name: <kebab>` / `description: ...` / `---`；`name` 全部通过宿主 `SKILL_NAME`（宿主 `index.ts:21`）语法，实测 `list()` 未告警（`errors: 0`）。

---

## 2. 缺陷卡片（按阻塞性排序）

### D1【阻塞 · 文档与代码直接矛盾】`docs/agent-team-api.md:352` 仍把已删除的 `REVIEWER_LABEL_PHRASE_RE` 写成生效判据

- **位置证据**
  - `docs/agent-team-api.md:352`（本轮新增行，`git diff -- docs/agent-team-api.md` 第 70 行以 `+` 开头）：「…`REVIEWER_LABEL_PHRASE_RE` 认 label 中独立的 `code review` 词组…」
  - `grep -c "REVIEWER_LABEL_PHRASE_RE =" index.js` → `0`；常量只剩 `index.js:291` `REVIEWER_NAME_RE` 与 `index.js:295` `REVIEWER_LABEL_RE`（锚定 + `please` 前缀），`index.js:316` 只有这两条判据。
  - 同一改动集里的 `README.md:83` 已写「判据一律锚定在 label 开头，**不做任意位置的子串匹配**（旧版曾有一条 `REVIEWER_LABEL_PHRASE_RE = /\bcode[\s_-]+review(?:er)?\b/`，已删除）」——两份文档互相矛盾。
- **破坏性反例**（实测，`isReviewerActivation({ label })`）：
  - 文档口径（存在短语判据）⇒ `修复 code review 面板的崩溃` / `实现 code review 能力` / `给 code-review 加个按钮` 应为 `true`；
  - 代码实际 ⇒ 三条都是 `false`（终态实测），而这正是本轮刚被打回并修复的误判样例。照 API 文档行事的人会认为「独立 code review 词组」应当命中，极可能把那条非锚定正则重新加回去，直接复活本轮的阻塞缺陷。
  - 同一句还漏掉了代码已实现的 `please` 礼貌前缀（`index.js:295` `^\s*(?:please\s+)?`；实测 `please review` → `true`），与 `README.md:83` 也不一致。
- **整改要求**：改写 `docs/agent-team-api.md:352` 的 label 段，与 `index.js:291-296` 逐字对齐——删除 `REVIEWER_LABEL_PHRASE_RE` 的判据描述，明确「label 判据一律锚定在开头（容忍前置空白与 `please`），后接结尾或分隔符；不做任意位置子串匹配」，并补上 `please` 前缀与实现类反例（与 `README.md:83` 保持同一口径）。

### D2【非阻塞 · 宿主契约口径不完整】`rank` 被当成跨来源优先级，跨层实际是「最近层直接胜出」

- **位置证据**：`docs/agent-team-api.md:384`、`docs/install.md:207`、`docs/DELIVERY.md:63` 都用「rank 越小越优先」推出「`~/.dsh/skills`（400）优先于本插件（550）」。宿主 `packages/skill/skill/src/index.ts:552-556` 写的是「Global first, then … the nearest layer's same-name entry replaces the farther ones — **Rank decides duplicates only within one layer**」；同文件 `:349-352` 补充「插件若挂在 agent preset 的 standing composition 上就落在该 preset 层」。
- **当前安装里的实测**：本会话（该 host）技能目录里 `team-parallel-dispatch` 的 description 与 `~/.dsh/skills/team-parallel-dispatch/SKILL.md` 逐字相同（含 `spawn_teammate` / `pull-based`），而随包版本已改为 `batched subagent` / `board-driven` —— 说明**本机当前确实命中 user-dsh(400) 那份**，文档结论没错，但推理口径（纯 rank）不完整：若插件 provider 落在更近的层，同名会由插件胜出而与 rank 无关。
- **整改要求**：在这三处文档补一句层口径（「rank 只在同一层内决定重名；跨层由层近远决定，本安装两者同在 global 层故 400 胜出」），或在 `docs/install.md` 的自检命令里加一步「确认命中来源」（例如比对 `list()` 结果的 `source` / `path`），把结论从推理升级为实测。

### D3【非阻塞 · 测试把缺陷写成结论而非防御】`invalidRouteLabel(null)` 抛 `TypeError` 被当作期望行为断言

- **位置证据**：`tests/client-ui.test.js:457` `assert.throws(() => __test.invalidRouteLabel(null), { name: 'TypeError' })`；`tests/client-ui-behavior.test.js:738` 用例名直接写「null 直接抛错（实现无空值防御）」。
- **影响面**：面板内两个调用点 `client.js:985`、`client.js:1193` 的 `draft` 来自 `client.js:898-903` 的 React state，初始即六字段对象且只会被 `buildDraft` 替换 → 无真实崩溃路径，所以不是线上缺陷；但测试记录缺陷而不修，等于把「缺空值防御」合法化。
- **整改要求**：`invalidRouteLabel` 开头加一行 `draft = isObject(draft) ? draft : {}`（或显式 `if (!isObject(draft)) return ''`），并把该断言改成「null 一律视为全继承默认 = 合法」，与 `routeOf` / `buildWorkspacesMutation` 的既有防御口径一致。

### D4【非阻塞 · 可观测性语义应写清】warn-once 是「每进程一次」，配置修好后再次半残不会再次告警

- **位置证据**：`index.js:112` `warnedReviewerConfig = new Set()`、`index.js:1189` `warnedSkillIssues = new Set()` 均为模块级、从不清理；`index.js:128-131` 命中后永久静默。
- **缓解**：与仓库既有口径一致（`git show HEAD:index.js` 里 `warnedMode` 同样是模块级一次性标志），且去重键是配置位置，不会跨位置串扰；实测同一 location 重复解析 3 次只 1 条 warn。
- **整改要求**：仅需在注释/文档里把「warn-once」明确为「同一配置位置每进程一次」，避免运维误以为每次加载都会重新提醒。

### D5【观察 · 判据偏宽】裸 `review` 开头 + 任意宾语也判 `true`

- **实测**：`review 需求文档` / `review 面板文案` / `review the docs` / `review 配置迁移` → 全部 `true`（`index.js:295` 中 `review(?:ing)?(?:\s+(?:code|diff|pr|changes|impl\w*))?` 的宾语是可选的，后面只要接空格就命中）。
- **危害评估**：这类 label 确实是「评审类」任务而非实现类，被送进审查代码模型的代价低（只是选一个模型，不改变门禁或委派），与 D1/修复前的实现类误判不同级；但与 `README.md:83` 自称的「宁可漏判」略有张力。
- **整改要求（可选）**：若要与「宁可漏判」严格一致，把该可选宾语改为必需（`review(?:ing)?\s+(?:code|diff|pr|changes|impl\w*)`），并保留 `review` 单独成条的分支。

---

## 3. 严打清单逐项结论

| 项目 | 结论 | 证据 |
|---|---|---|
| 硬编码 / 为测试写特判 | 未发现 | reviewer 判定只有两条通用正则（`index.js:291/295`），无按输入分支；`PACKAGED_SKILL_RANK = 550`（`index.js:1181`）、`SKILL_SOURCE = 'custom'`（`index.js:1183`）是有宿主依据的常量（宿主 `index.ts:28` `BUNDLED_SKILL_RANK = 600`、`skill-filesystem/src/index.ts:37-39`），不是魔法数字凑测试 |
| 空 catch / 只打日志假装处理 / 空默认值掩盖故障 / TODO 占位 | 未发现 | `index.js:1786-1795` 的 catch 有计数 + `console.error` 兜底；`index.js:1220/1262` 区分 `ENOENT`（正常）与真实错误（warn-once）；`index.js:1216` 读失败返回 `undefined` 并告警，不是静默空数组；全仓 `grep -n TODO index.js` 无未实现占位 |
| 虚假测试 / 断言恒真 / 过度 mock / 缺边界异常 | 未发现 | 见 §6；无 `expect(true)` 型断言（`grep` 无命中）、无 `{ todo }` / `skip`（`grep` 无命中）；异常与边界用例齐备（`R5`–`R7`、`R13`、`R14`、`F3`、`i)`、`190/204/238/248/271/314/331/341/352`） |
| 架构走捷径 / 宿主契约口说无凭 | 大体有据，仅 D2 口径不完整 | 宿主引用逐条可核对：`packages/subagent/subagent/src/types.ts:29`、`manager.ts:340`、`packages/skill/skill/src/index.ts:21/43-44/49-53/390/552-556`；实测输出见 §1 契约 5 的 provider 运行记录 |

---

## 4. 测试真实性复核（我亲自运行的命令与输出）

### 4.1 全量

```text
$ node --test tests/*.test.js        # 两次独立运行（修复落地后）
node v26.13.1
ℹ tests 663
ℹ pass 663
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 277.4 / 288.4
```

修复落地前的同一条命令是 `tests 660 / pass 660 / fail 0`（当时判据缺陷尚未被测试覆盖，见 §4.3）。

### 4.2 反向自检是否真能失败（变异反证）

`tests/capacity-settings.test.js` 静态守卫重写：`indexJsFileApiViolations`（`:276-297`）仍然抓

- 写/改/删 API 调用点：`WRITE_FILE_APIS`（`:241-244`）+ `open(`（`:286`），`callSiteRe`（`:253`）是调用点口径（近名 `perform` / `confirm` / `reopened` 不误判，`:332-337` decoy 用例必须绿）；
- `node:fs` 写入通道：具名导入只允许 `readdir/readdirSync/readFile/readFileSync`（`:250/287-292`），默认/命名空间导入、`require`、动态 `import` 一律红（`:258-263/293-295`）；
- 代码行里的 `cordis.patch.yml`：`:279-282` 仍然违规，**纯注释行**放行。

守卫自检（`:307-341`）实测在套件内通过，且我独立核对了它抓得住：违规样例必须含 `writeFile` / `writeFileSync` / `rmSync` / `open(` / `cordis.patch.yml` 五项（`:316-318`）。

被弱化的只是「注释行提 patch 文件名」这一点：`index.js` 里两处出现都在注释行（`index.js:999` 以 `/**` 开头、`index.js:1122` 位于块注释内），不是可执行写入路径；同时我独立验证写入通道确实为零：

```text
$ grep -n "writeFile\|appendFile\|rename\|mkdir\|chmod\|unlink\|createWriteStream\|\bopen(\|rmSync\|\brm(" index.js client.js   → 无匹配
$ grep -n "node:fs" index.js client.js
index.js:22:import { readdir, readFile } from 'node:fs/promises'      # 唯一的 fs 导入，只读
```

结论：原意图（插件不得再写任何配置文件）未被削弱，反向自检真实可红。

### 4.3 判据不变式测试的真实有效性

`R14`（`tests/model-route-config.test.js:630-642`）是 5 词组 × 9 句式 = 45 条参数化断言。离线复算旧实现 vs 现实现：`oldMatches: 36, newMatches: 0` —— 旧实现下该测试必红 36 条。`R13`（`:620-628`）逐条覆盖 Lead 实测的 4 条样例 + 2 条英文样例，并额外断言 preset 弱信号不能翻案。修复前套件 660 全绿恰恰说明当时**缺**这组用例；现已补齐。

### 4.4 是否只测 mock 本身 / 是否恒真

- 路由注入用例走插件真实入口（`apply(host.ctx, cfg)` → `host.subagents.startActivation(spec)` → 断言宿主收到的 spec），断言落在 `agentOptions` 深相等、`'request' in seen === false`、入参对象身份不变（`tests/team-model-route.test.js:591-602`）。
- skills 用例里 `list()/get()` 读的是**真实** `skills/` 目录（我另行在无 mock 环境下复跑，见 §1 契约 5）。
- 断言密度：`team-model-route` 153、`route-override-observability` 113、`skills-provider` 103、`model-route-config` 118、`client-ui-behavior` 164 条 `assert.*`；`grep` 未发现恒真断言。

---

## 5. 文档一致性抽查（逐字 5 处）

| # | 文档断言 | 代码事实 | 结论 |
|---|---|---|---|
| 1 | `README.md:83` / `docs/agent-team-api.md:336`「`reviewer` **无默认值**，`DEFAULT_CONFIG` 不含该键」 | `index.js:42` `DEFAULT_CONFIG` 无 `reviewer`；`index.js:175-176` 未配置不挂字段；实测 `resolveConfig({}) deepEqual DEFAULT_CONFIG` | 一致 |
| 2 | `README.md:83` 回退链 `workspaces[key].reviewer` → 全局 `Config.reviewer` → 原本的 `member`/`subagent` | `index.js:1887-1892` + `index.js:270-275`；实测样例见 §1 | 一致 |
| 3 | `README.md:83`「判据一律锚定…旧 `REVIEWER_LABEL_PHRASE_RE` 已删除」，并举 6 条实现类反例 | `index.js:291/295/316`；6 条反例实测全 `false`（§1 契约 3 实测表） | 一致 |
| 4 | `docs/agent-team-api.md:352`「`REVIEWER_LABEL_PHRASE_RE` 认 label 中独立的 `code review` 词组」 | 该常量不存在（`grep -c` = 0）；实现判否 | **不一致 → 缺陷 D1** |
| 5 | `install.md:189-203` / `agent-team-api.md:383`「`rank = 550`、`source = 'custom'`、`provider = 'dsh-force-subagent'`」；`DELIVERY.md:57`「`#fsx-reviewerProvider` / `#fsx-reviewerModel`、留空提示…」 | 实测 `4` 条候选 `rank 550 / custom / dsh-force-subagent`；宿主 rank 常量核对（`index.ts:28`、`skill-filesystem/src/index.ts:37-39`）；id 由 `client.js:1291-1294` 生成 | 一致（唯 rank 的跨层推理口径需按 D2 补注） |

---

## 6. 结论

- 九条关键契约中，**1、2、3、4、5、6、7、9 全部独立核验通过**：配置归一化与 warn-once、reviewer 优先级链与注入语义（含向后兼容与入参不污染）、识别口径三段判定、留痕去重与 kind 不冒充、内置 skills provider 的真实读盘与注销器托管、客户端三张卡与校验点名、测试真实性（663/663 全绿 + 变异反证）、4 个 SKILL.md 的铁律保留与 frontmatter 合法性。
- Lead 实测发现的判据缺陷（非锚定 `REVIEWER_LABEL_PHRASE_RE` 导致 3 条实现类 label 误判）**已在本轮由并行修复闭环**，我用 `node --input-type=module -e` 亲自复跑 18 条样例（含原 4 条）全部正确，并用 45 条参数化反例证明新测试真实可红。修复终态：`index.js:291/295/316`（`grep -c "REVIEWER_LABEL_PHRASE_RE =" index.js` → `0`）。
- 仍有一处**阻塞性缺陷 D1**：本轮新增的 `docs/agent-team-api.md:352` 把已删除的 `REVIEWER_LABEL_PHRASE_RE` 写成生效判据，且漏写 `please` 前缀，与 `index.js` 和同一改动集里的 `README.md:83` 互相矛盾，会把后来人引向「把非锚定正则加回去」这条已知错误路径。整改只需改该文档句，不涉及代码。
- 另有 4 项非阻塞项（D2 层口径、D3 测试把缺陷当期望、D4 warn-once 语义未写清、D5 裸 `review` 判据偏宽）。

**判据：代码与测试侧无糊弄、测试真实全绿；但文档与代码在核心识别口径上存在实质矛盾，必须先修 D1 才能放行。**

VERDICT: REJECT
