# 第二轮对抗复核：审查代码模型（reviewer 路由）D1–D5 修复核验

复核人：`reviewer-2`（接替第一轮 `reviewer` 的 REJECT 判决）
复核对象：`/home/csy/Code/Github/dsh-force-subagent` 工作区现状（未提交改动集，含第一轮修复与第二轮整改）
原始报告：`docs/review-reviewer-model.md`（第一轮 `VERDICT: REJECT`，阻塞项 D1）
被复核的口头结论：`worker-fix-2` 声称 D1–D5 全部修完、`node --test tests/*.test.js` = 664/664。
本报告全部结论来自我自己运行的命令与我自己读到的行号；未采信任何口头结论。

---

## 0. 复核方法（我实际执行的命令）

工具环境说明：本会话 `mcp__vectr__vectr_status` 返回 `unknown tool`（vectr 的状态工具不可用），按检索回退链降级为 `vectr_search` / `vectr_fetch` + `read` + `grep`；所有引用都有行号或实测输出。

| # | 命令 | 用途 |
|---|---|---|
| 1 | `grep -n "REVIEWER_NAME_RE\|REVIEWER_LABEL_RE\|REVIEWER_LABEL_PHRASE_RE" README.md docs/agent-team-api.md docs/install.md docs/DELIVERY.md docs/*.md index.js client.js tests/*.test.js` | D1 判据口径与旧常量残留 |
| 2 | `grep -c "REVIEWER_LABEL_PHRASE_RE =" index.js` → `0` | 确认旧常量未复活 |
| 3 | `awk 'NR>=283..324' index.js`（逐行打印） | 逐字对照代码 |
| 4 | `node --input-type=module -e ... isReviewerActivation` 三轮矩阵（38 条指定样例 + 24 条自选对抗样例 + 12 条轮次分支样例 + 6 条 colon-token 样例） | D1/D5 判据实测 |
| 5 | 变异反证 A：把 `REVIEWER_LABEL_RE` 改回**非锚定**写法 → `node --test tests/model-route-config.test.js` 变红 → `cp` 还原 + `diff` + `md5sum` | 证明 R13/R14 不是恒真 |
| 6 | 变异反证 B：给 `review(?:ing)?` 加回「宾语可选」分支 → `node --test tests/*.test.js` 变红（663/1）→ 还原 + `diff` + `md5sum` | 证明 R16 是真实载荷测试 |
| 7 | `cp client.js /tmp/client.js.bak` → 把 `invalidRouteLabel` 的 `isObject` 守卫改成 `var source = draft;` → `node --test tests/client-ui.test.js tests/client-ui-behavior.test.js` 变红 → `cp` 还原 + `diff`（空）+ `md5sum`（相同） | D3 反向验证 |
| 8 | `grep -n "warnedReviewerConfig\|warnedSkillIssues" index.js`；`grep -n "warned[A-Za-z]*\.\(clear\|delete\)" index.js`（无匹配） | D4 行为未被改动 |
| 9 | `node --test tests/*.test.js`；`node --test tests/verify/using-agent-team.test.js`；`node --test tests/*.test.js tests/verify/*.test.js` | 全量测试与覆盖完整性 |
| 10 | `grep -rn "skip: true\|test.todo\|only: true" tests/*.js`（0 命中）、`grep -rn "assert.ok(true\|assert.equal(true, true" tests/*.js`（0 命中） | 测试真实性 |
| 11 | `node --input-type=module -e` 调 `resolveConfig({})` / `resolveConfig(undefined)` 与 `DEFAULT_CONFIG` 做 `deepStrictEqual` | 回归项 |
| 12 | `grep -c "spawn_teammate" skills/*/SKILL.md`；`grep -n "emptyHint\|ROUTE_GROUPS = \[" client.js` | 回归项 |
| 13 | 宿主源码取证：`grep -n "nearest layer\|Rank decides\|collectFresh" packages/skill/skill/src/index.ts` + `awk` 打印 345-352 / 549-600 / 52-92；`grep -rn "BUNDLED_SKILL_RANK\|USER_DSH_RANK\|USER_AGENTS_RANK"` | D2 宿主契约核对 |
| 14 | 跑 `docs/install.md` 里的两条自检命令原文 | D2 自检步可执行性 |
| 15 | catch 块审计脚本（index.js/client.js 全部 `catch` 站点的后续 4 行） | 严打清单「空 catch / 只打日志」 |

代码状态守恒证明（我做过 3 次临时变异，全部还原）：

```
index.js   md5 = 0e069405e80d43f3aa7e4da3ee698f73  （与 /tmp/index.js.bak 相同，diff 空）
client.js  md5 = 3f336b2784ec81694f027f2c3ec9273b  （与 /tmp/client.js.bak 相同，diff 空）
```

---

## 1. D1（第一轮阻塞项：文档把已删除的 `REVIEWER_LABEL_PHRASE_RE` 写成生效判据）

### 1.1 代码侧终态（我逐行读到）

```
index.js:294  const REVIEWER_NAME_RE = /^(?:[a-z0-9-]+-)?reviewer(?:-\d+)?$|^(?:code-)?review(?:-\d+)?$/
index.js:295  // label 判据锚定在开头：^\s*(?:please\s+)? 只容忍前置空白与礼貌前缀，不是放宽子串匹配。
index.js:296  // 旧版另有一条非锚定的 REVIEWER_LABEL_PHRASE_RE（/\bcode[\s_-]+review(?:er)?\b/，任意位置子串匹配），
index.js:297  // 它把实现类 label 误判成审查任务，已删除；锚定的 code…review 词组由本条覆盖。
index.js:302  const REVIEWER_LABEL_RE = /^\s*(?:please\s+)?(?:code[\s_-]*review(?:er)?|review(?:ing)?\s+(?:the\s+|this\s+|that\s+|a\s+|an\s+)?(?:code|diff|pr|changes|impl\w*|patch|commit|pull request)|review(?:ing)?(?:[ \t]*$|[ \t]*[:：(（][ \t]*(?:(?:round|pass|iter|iteration|轮|第|批|次)[ \t]*#?\d+|#?\d+)[)）]?[ \t]*$)|代码审查|审查代码|对抗审查|代码评审|评审代码)(?:$|[\s:：\-—(（])/i
index.js:311-313  name 非空 → 只认 REVIEWER_NAME_RE，不命中直接 false（不回落 label）
index.js:315-316  name 空 → 试 request.agentPreset（同一套名字语法）
index.js:318-323  都为空 → 才看 label：REVIEWER_LABEL_RE.test(label) || REVIEWER_NAME_RE.test(label.toLowerCase())
```

`grep -c "REVIEWER_LABEL_PHRASE_RE =" index.js` → **0**：常量确实不存在。

### 1.2 旧常量残留检查（要求「写成生效判据即 REJECT」）

`grep -rn "PHRASE_RE" README.md docs/ index.js client.js tests/`，排除第一轮报告自身后只剩 4 处，且全部是「已删除 / 历史说明」：

| 位置 | 措辞 | 是否生效判据 |
|---|---|---|
| `README.md:83` | 「旧版曾有一条 `REVIEWER_LABEL_PHRASE_RE = /\bcode[\s_-]+review(?:er)?\b/`，已删除」 | 否（历史说明） |
| `docs/agent-team-api.md:352` | 「**不做任意位置的子串匹配，旧版那条非锚定的 `REVIEWER_LABEL_PHRASE_RE`（…）已删除**」 | 否（历史说明） |
| `index.js:296` | 「旧版另有一条非锚定的 … 已删除」 | 否（注释） |
| `tests/model-route-config.test.js:614` | 「一旦退回非锚定子串匹配（旧 `REVIEWER_LABEL_PHRASE_RE` 的写法），R13 / R14 必须变红」 | 否（反证注释） |

**没有任何一处把它写成生效判据。**

### 1.3 文档 ↔ 代码 逐字对照（`README.md:83`、`docs/agent-team-api.md:352`、`index.js:294/302/311-323`）

| 口径要求 | `docs/agent-team-api.md:352` | `README.md:83` | `index.js` | 一致 |
|---|---|---|---|---|
| `REVIEWER_NAME_RE` 原文 | 逐字给出 `^(?:[a-z0-9-]+-)?reviewer(?:-\d+)?$|^(?:code-)?review(?:-\d+)?$` | 列出 `reviewer / reviewer-1 / code-reviewer / adversarial-reviewer / review / code-review` 一族 | :294 同一串 | ✅ |
| name 非空即只认 name，不回落 label | 「不命中就直接判否、绝不回落到 label」 | 「给了非 reviewer 的名字…绝不回落到 label」 | :313 `return REVIEWER_NAME_RE.test(name)` | ✅ |
| preset 次优先 | 「`name` 为空时才试 `request.agentPreset`」 | ② 同口径 | :315-316 | ✅ |
| 锚定开头 | 「一律锚定在 label 开头——`^\s*(?:please\s+)?`」 | 同句 | :302 `^\s*(?:please\s+)?` | ✅ |
| `please` 前缀 | 明写「只容忍前置空白与 `please` 礼貌前缀」 | 明写 | :302 `(?:please\s+)?` | ✅ |
| 词组后接结尾或分隔符 | 「必须紧跟结尾或分隔符 `$ \s : ： - — ( （`」 | 同句 | :302 外层 `(?:$\|[\s:：\-—(（])` 逐项相同 | ✅ |
| 两条判据 | 「label 判据只有两条：`REVIEWER_LABEL_RE` 与 `REVIEWER_NAME_RE`（整条 label 小写后本身就是 reviewer 名字）」 | 同句 | :323 正是这两条 | ✅ |
| ① `code[\s_-]*review(?:er)?` | 逐字 | 逐字 | :302 | ✅ |
| ② 宾语必需（冠词 the/this/that/a/an + code\|diff\|pr\|changes\|impl\w*\|patch\|commit\|pull request） | 逐字列出，宾语族与代码集合完全一致 | 同 | :302 | ✅ |
| 整条 label 就是 `review` / `reviewing`（可带尾随空白） | 有 | 有 | :302 `review(?:ing)?(?:[ \t]*$\|…)` | ✅ |
| `review: round 2` / `review (2)` 分支 | 「紧跟冒号或左括号且其后只有轮次编号」 | 同 | :302 `[:：(（] … (?:round\|pass\|iter\|iteration\|轮\|第\|批\|次)#?\d+ \| #?\d+ … $` | ✅ |
| ③ 中文族 5 个词 | 逐字 | 逐字 | :302 | ✅ |
| 不做任意位置子串匹配 | 「不做任意位置的子串匹配，旧…已删除」 | 「**不做任意位置的子串匹配**」 | :295/:322 注释 + 锚定实现 | ✅ |
| 实现类反例 | `修复 code review 面板的崩溃`、`实现审查代码模型`、`修复代码审查bug` 判否 | 另举 `实现 code review 能力`、`给 code-review 加个按钮`、`implement code review feature`、`add code review button` | 实测全 false（见 1.4） | ✅ |
| 带非代码宾语判否（D5 收紧后） | `review 需求文档`/`review 面板文案`/`review the docs`/`review 配置迁移` 判否 | 同四条 | 实测全 false | ✅ |

**D1 判定：真实修复。** 文档与代码同口径，旧常量未复活、且四份文档 + 代码 + 测试注释对 label 判据的描述互相一致。

### 1.4 反证（证明判据与测试都是真的，不是糊弄）

变异 A：把 `index.js:302` 的开头改为非锚定写法 `/(\.*\s)?(?:please\s+)?(?:code[\s_-]+review(?:er)?|…`（等价于把旧 `REVIEWER_LABEL_PHRASE_RE` 加回去）后：

```
✖ R13 isReviewerActivation：Lead 实测复现的误判样例（实现类 label）修复后必须判 false
✖ R14 isReviewerActivation：不变式 —— 审查词组只出现在 label 中间 / 末尾时一律 false（禁止任意位置子串匹配）
ℹ tests 36 / pass 34 / fail 2
```

还原后 `diff /tmp/index.js.bak index.js` 空、md5 相同。→ R13/R14 确实会因「退回子串匹配」变红，不是恒真断言。

---

## 2. D2（`rank` 被当成跨来源优先级）

### 2.1 宿主源码原文（我亲自取证的真实行号，宿主 checkout `deepseek-harness-0.2.2-rc.2`）

- `packages/skill/skill/src/index.ts:551-555`（`collectFresh` 注释）：
  `// Global first, then existing chain overlays farthest ancestor first and / the nearest layer's same-name entry replaces / the farther ones — the tools registry's shadowing rule. Rank decides / duplicates only within one layer.`
- `packages/skill/skill/src/index.ts:556-563`：`layers = [global, ...chainLayers]`，逐层 `merged.set(entry.candidate.name, entry)` —— 更近的层**直接覆盖**，与 rank 无关。
- `packages/skill/skill/src/index.ts:567-576`：同层内 `collected.entries.sort(compareIndexedCandidates)` + `seen` 去重（重名在同层内按 rank 决出，多余的同名条目 warn 后丢弃）。
- `packages/skill/skill/src/index.ts:345-352`（注册到哪一层）：「host rows and repository plugins land in the global layer, while a plugin mounted by an agent preset's standing composition lands in that preset's layer … the nearest layer's entry wins a duplicate name outright, and the rank order decides duplicates only within one layer」。
- `packages/skill/skill/src/index.ts:78`（`SkillCandidate.rank`）：「Lower ranks win duplicate skill names before provider registration order is considered.」
- 常量：`BUNDLED_SKILL_RANK = 600`（`packages/skill/skill/src/index.ts:28`）、`USER_DSH_RANK = 400`、`USER_AGENTS_RANK = 500`（`packages/skill/skill-filesystem/src/index.ts:38-39`，用于 `:263-264` 的两个根）。
- `SkillSummary` 确有 `path`（:59）与 `source`（:69）—— `docs/install.md:207` 的「比对 `source` / `path`」这一说法在宿主侧有依据。

**宿主契约确为「跨层最近层直接胜出，rank 只在同层内决定重名」，第一轮 D2 的结论成立。**

### 2.2 三处文档是否都补了层口径

| 文档 | 位置 | 三个要点（跨层最近层胜出 / rank 只在同层 / 本安装同在 global 层故 400 胜出） |
|---|---|---|
| `docs/agent-team-api.md` | :384（「重名去重」行） | 三点齐备，并额外写明「若插件 provider 落在更近的层，同名会由本插件胜出，与 550 / 400 的大小无关」+ 指向 `docs/install.md` 自检 |
| `docs/install.md` | :218（「重名优先级（层口径，不是纯 rank）」） | 三点齐备，并写明常量不能跨层排序、插件不会替用户删旧拷贝 |
| `docs/DELIVERY.md` | :63（「注意（层口径，不是纯 rank）」） | 三点齐备（「本插件 provider 与 `~/.dsh/skills`（`user-dsh` 根）同在 global 层，同层比 rank 故 400 胜出」） |

第一轮把 rank 当跨层优先口的表述（旧 `agent-team-api.md:384` / `install.md:207` / `DELIVERY.md:63`）在当前文件中已不存在——当前三处均以「层口径，不是纯 rank」为标题性表述。

### 2.3 `docs/install.md` 新增的「确认命中来源」自检步：可执行性实测

新增步在 `docs/install.md:207-215`（「确认命中来源（第二步自检）」），我按其原文执行：

```
$ cd /home/csy/.dsh/profiles/web && node --input-type=module -e "import('/home/csy/Code/Github/dsh-force-subagent/index.js').then(async m=>console.log((await m.listPackagedSkillCandidates(m.PACKAGED_SKILLS_ROOT)).map(s=>[s.name,s.rank,s.source,s.provider].join(' | ')).join('\n')))"
team-adversarial-gatekeeper | 550 | custom | dsh-force-subagent
team-lead-delegation | 550 | custom | dsh-force-subagent
team-parallel-dispatch | 550 | custom | dsh-force-subagent
team-recursive-orchestration | 550 | custom | dsh-force-subagent

$ ls -d ~/.dsh/skills/team-* 2>/dev/null            → 无输出
$ grep -l "spawn_teammate" ~/.dsh/skills/team-*/SKILL.md 2>/dev/null → 无输出
$ grep -c "batched subagent\|board-driven" /home/csy/Code/Github/dsh-force-subagent/skills/team-parallel-dispatch/SKILL.md → 1
```

**D2 判定：真实修复**（口径已补、宿主依据成立、自检命令可执行）。附带一条新发现，见 §4 缺陷卡片 N1。

---

## 3. D3（`invalidRouteLabel(null)` 抛 `TypeError` 被当成期望行为）

### 3.1 代码侧空值防御（真实存在，不是注释）

```
client.js:305-310  注释明确「draft 不是对象（null / undefined / 字符串之类）一律视为『三组路由都继承默认』= 合法，返回 ''，不谎报卡名、也不抛 TypeError」
client.js:311-319  function invalidRouteLabel(draft) {
                     var source = isObject(draft) ? draft : {};        ← 第 312 行，真实守卫
                     ... ROUTE_GROUPS.forEach(... routePairValid(source[...], source[...]) ...)
client.js:321-327  注释钉死 draftIsValid 的空值语义
client.js:328-330  function draftIsValid(draft) { return invalidRouteLabel(draft) === ''; }   ← 语义完全由 invalidRouteLabel 决定，口径唯一
```

`isObject` 为 `client.js:55` 的本地纯函数；空 draft → `routePairValid(undefined, undefined)` → 都为空 → 合法 → `''`。与 `routeOf`（`client.js:63-64`）、`buildWorkspacesMutation`（:211）的既有「非对象当空」口径一致。

面板调用路径一致：`client.js:995-997`（`invalidGroup = invalidRouteLabel(draft)` → `valid`/`canSave`）与 `client.js:1203-1205`（`if (!draftIsValid(draft)) showFailure(invalidGroup + …)`）；`draft` 来自 React state，仅由 `buildDraft`（定义 `client.js:196`，写入 `client.js:970`）产生，故面板侧行为未变。

### 3.2 测试是把断言**改写**而不是删除

- `tests/client-ui.test.js:459-462`：`invalidRouteLabel(null|undefined|'nope'|42)` → `assert.equal(..., '')`，message 明写「必须视为全继承默认 = 合法，且不得抛错」。
- `tests/client-ui.test.js:463-465`：`draftIsValid(null|undefined|'nope')` → `true`，并断言与 `invalidRouteLabel` 同一口径。
- `tests/client-ui-behavior.test.js:738-761`：测试名改为「…空值一律视为『全继承默认』= 合法（空值防御已落地）」，含 `{}` / 全空串 / 半对 / 非字符串 / `null` / `undefined` / `'nope'` 的**正反双向**断言。
- `grep -c "assert.throws" tests/client-ui.test.js tests/client-ui-behavior.test.js` → `0` / `0`：旧的 `assert.throws(TypeError)` 被替换为合法断言，而非整条删除；两个测试文件都没有留下任何「期望抛错」的残留。

### 3.3 反向验证（临时注掉守卫）

```
$ cp client.js /tmp/client.js.bak
（edit）client.js:312  var source = isObject(draft) ? draft : {};   →   var source = draft;
$ node --test tests/client-ui.test.js tests/client-ui-behavior.test.js
✖ draftIsValid：成对才为真，半对为假，空值一律视为「全继承默认」= 合法（空值防御已落地）
  TypeError [Error]: Cannot read properties of null (reading 'memberProvider')
      at invalidRouteLabel (…/client.js:314:20)
      at Object.draftIsValid (…/client.js:329:14)
  TypeError [Error]: Cannot read properties of null (reading 'memberProvider')
      at Object.invalidRouteLabel (…/client.js:314:20)
$ cp /tmp/client.js.bak client.js && diff /tmp/client.js.bak client.js   → 空
$ md5sum client.js /tmp/client.js.bak → 3f336b2784ec81694f027f2c3ec9273b（相同，无残留）
```

**D3 判定：真实修复。** 防御真实存在（注掉即变红），测试语义确定、与面板路径一致，断言是改写不是删除。

---

## 4. D4（warn-once 语义未写清）

### 4.1 注释/文档已写明「同一配置位置每进程一次」

```
index.js:108-114  * 半残可选路由只告警一次… 去重键是「配置位置」，所以全局 reviewer 与某个 workspaces 条目的 reviewer 各算一次。
                  * warn-once 的确切语义：模块级 Set、每进程只提醒一次 —— 同一个配置位置在本进程内第一次半残才告警，
                  * 之后无论重新解析多少次（含配置改好后再次半残）都不再重复告警；它不是「每次加载 / 每次解析都提醒」。
                  * 跨进程（重启或热重载后重新 apply 插件、模块重新求值）才会重新计数。
README.md:77      「只配一半会被整条忽略（并 warn 一次，同一配置位置每进程只提醒一次）」
docs/agent-team-api.md:388 「经 warnSkills 同一原因只 warn 一次（模块级 Set、每进程一次，按问题文案去重…）」
index.js:1197      「warn-once 的确切语义：模块级 Set、每进程一次，去重键是『问题键』…」
```

### 4.2 行为未被为了「每次提醒」而改动

- `index.js:115 const warnedReviewerConfig = new Set()`（模块级，`:131-132` 只 `has`/`add`）
- `index.js:1201 const warnedSkillIssues = new Set()`（`:1325-1326` 只 `has`/`add`）
- `grep -n "warned[A-Za-z]*\.\(clear\|delete\)" index.js` → **无匹配**：没有任何清理 Set 以「重新提醒」的代码。

既有测试口径也未被削弱：`tests/model-route-config.test.js:400`（同一位置重复解析仍只 1 条，message「warn-once 失效：重复解析仍在告警」）、`:417-418`（按 location 去重并断言文案含 `/repo/b`）、`tests/workspace-route.test.js:201`（全局与工作区条目各 1 条 = 2）。

**D4 判定：真实修复**（仅补文档/注释口径，行为保持不变且仍有测试锁住）。

---

## 5. D5（裸 `review` 宾语可选）

### 5.1 我亲自运行的指定矩阵（`node --input-type=module -e`，直连 `./index.js` 导出的 `isReviewerActivation`）

14 条必须 false + 21 条必须 true + 3 条 name 优先级：

```
neg_count=14 pos_count=21 name_cases=3 failures=0
```

即以下全部按要求判定：
- 要求 false 且全部 false：`review 需求文档`、`review 面板文案`、`review the docs`、`review 配置迁移`、`review docs`、`review requirements`、`review the plan`、`please review 需求文档`、`review 需求文档 第二轮`、`实现 code review 能力`、`修复 code review 面板的崩溃`、`给 code-review 加个按钮`、`修复代码审查bug`、`实现审查代码模型`
- 要求 true 且全部 true：`code review`、`code-review`、`codereview`、`code reviewer`、`Code Review`、`code review this diff`、`code-review the diff`、`code reviewer needed`、`review the diff`、`review impl`、`review the code`、`reviewing changes`、`代码审查`、`审查代码`、`对抗审查`、`代码评审`、`评审代码`、`please code review this diff`、`review: round 2`、`review`、`reviewing`
- name 优先级：`{name:'worker', label:'审查代码'}` → false；`{name:'code-impl', label:'code reviewer'}` → false；`{name:'reviewer', label:'实现审查代码模型'}` → true

### 5.2 我自选的额外对抗样例（不在任何一方给的清单里）

```
ok   "review commit" => true          ok "reviewing patch changes" => true
ok   "please review the diff" => true  ok "  code review this diff  " => true
ok   "\nreview the diff\n" => true     ok "review 文案" => false
ok   "review (2)" => true              ok "review 2" => false        ok "review#2" => false
ok   "修复 reviewer 面板崩溃" => false  ok "reviewer 面板崩溃修复" => false
ok   "implement reviewer routing" => false  ok "面板崩溃修复（code review）" => false
ok   "审查代码模型配置迁移" => false     ok "review the codebase" => false
INFO "code reviewable" => false（词尾未接分隔符，未误判）
ok   "REVIEW-2" => true  ok "reviewer-ui" => false  ok "impl-reviewer-ui" => false
ok   "reviewerx" => false ok "senior_reviewer" => false ok "bug-review" => false
ok   "review-model-config" => false  ok "" => false  ok "   " => false
```

轮次编号分支边界：`review: pass 2` / `review: 轮 2` / `review: 批 2` / `review (第 3)` / `review：round 12` / `review (round 3)` / `review: iteration 10` / `review: #3` → true；`review: 第 2 轮`、`review: 批次 7`、`review (3rd)`、`review: round 2 附加说明`、`review: round 2 #` → false（编号必须是 label 的结尾，见 §6 观察 N2）。

### 5.3 反证（收紧是否真的载荷化）

变异 B：给 `REVIEWER_LABEL_RE` 加回「宾语可选」的 `|review(?:ing)?|` 分支（即 D5 修复前的宽判据）：

```
$ node --test tests/*.test.js
✖ R16 isReviewerActivation：裸 review 的宾语不许任意 —— 只有代码审查宾语、整条结束或轮次编号标注才命中
ℹ tests 664 / pass 663 / fail 1
$ cp /tmp/index.js.bak index.js && diff → 空；md5 0e069405e80d43f3aa7e4da3ee698f73（相同）
```

且 `tests/model-route-config.test.js:649` 的 R15 显式反向防糊弄（「锚定不得过头 —— 开头即审查意图的 label 仍须命中，防止用『一律 false』糊弄 R13/R14」），`:673-676` 显式检查「收紧只作用于 review+宾语这一族，code review 词组族与中文族不得被连带砍掉」。**D5 判定：真实修复，且收紧没有用「一律 false」作弊。**

---

## 6. 新发现问题（均不构成阻塞）

### N1【P2 · 文档与当前安装环境不符（非代码缺陷）】「400 胜过本插件 550」已被环境变更作废

- **位置**：`docs/install.md:218`、`docs/DELIVERY.md:63`、`docs/agent-team-api.md:384` 均写「本安装**实测**结论：…同层比 rank，所以 `~/.dsh/skills` 的同名条目（400）胜过本插件（550）」。
- **实测证据**：`ls -d ~/.dsh/skills/team-*` 无输出；`find ~/.dsh -name SKILL.md -path "*team*"` 只命中 `~/.dsh/backups/skills-team-20261118-140511/<name>/SKILL.md`（目录时间戳 2026-11-18 14:05）。旧拷贝的 frontmatter 是 `spawn_teammate … pull-based`，随包版本是 `batched subagent … board-driven`；本会话当前技能目录里 `team-parallel-dispatch` 的描述与**随包版本逐字相同**（会话中途技能目录刷新已确认）→ 现命中者是本插件 provider（550），不是 400。
- **为什么不阻塞**：宿主契约表述本身经源码核对完全正确（§2.1）；三处文档都写了条件分支「若 `~/.dsh/skills` 里还留着同名旧拷贝，命中的是那一份」，并按 D2 整改要求给了可执行的「确认命中来源」自检步（我已跑通）。作废的只是「本安装实测」这一措辞。
- **整改建议（一行）**：把「本安装实测结论」改为「条件式结论 + 当前实测」，注明 2026-11-18 已把 `~/.dsh/skills/team-*` 移入 `~/.dsh/backups/skills-team-20261118-140511`，故现命中随包 550 版本。

### N2【P3 · 文档可更精确】轮次编号分支只认「数字编号且位于 label 结尾」

`index.js:302` 要求冒号/左括号后是 `round|pass|iter|iteration|轮|第|批|次` + 数字、或裸数字，并且必须到达结尾。因此 `review: 第 2 轮`、`review: 批次 7`、`review (3rd)` 判否（实测见 §5.2）。文档写「其后只有轮次编号」，未点明必须是数字编号。与「宁可漏判」口径一致（漏判只回退 member/subagent 路由），属文档精度问题，不是实现缺陷。

### N3【P3 · 测试覆盖口径】`node --test tests/*.test.js` 漏掉 `tests/verify/using-agent-team.test.js`

`tests/` 下有 27 个条目：26 个 `*.test.js` + `verify/`（含 `using-agent-team.test.js`，18 个用例）+ `RUN_OUTPUT.txt`。给定命令只覆盖 26 个文件（664 用例）；我另跑 `node --test tests/verify/using-agent-team.test.js` → `tests 18 / pass 18 / fail 0`；合并口径 `node --test tests/*.test.js tests/verify/*.test.js` → **682 / 682 / 0（duration 299.19 ms）**。建议把文档与 CI 口径改为 `node --test "tests/**/*.test.js"`，否则 18 个契约用例不在全量口径内。

---

## 7. 全量测试与测试真实性

```
$ node --test tests/*.test.js            # 26 个文件
ℹ tests 664
ℹ suites 0
ℹ pass 664
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 292.087228

$ node --test tests/*.test.js tests/verify/*.test.js
ℹ tests 682 / pass 682 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 299.191197
```

- 与 `worker-fix-2` 声称的 664/664 一致（我自己跑出来的，不是转述）。
- `grep -rn "skip: true\|test.todo\|only: true" tests/*.js` → 0 命中；`ℹ skipped 0 / todo 0` → 无 skip / todo 掩盖。
- 新增用例有实质断言且参数化：`R13`（6 条实现类样例 + preset 翻案反证）、`R14`（5 词组 × 9 包装 = 45 条参数化不变式 + 6 条 reviewer-词中缀样例）、`R15`（反向防「一律 false」糊弄，含前置/后置空白）、`R16`（10 条宾语族正反 + 5 条「收紧不得连带砍掉」反证），`tests/model-route-config.test.js:548-555` 的 `verdict` 直连真实 `isReviewerActivation`（`import * as plugin from '../index.js'`，无 Mock 替身）。三次变异（A、B、D3 守卫）均证明这些断言可红。
- `grep -rn "assert.ok(true\|assert.equal(true, true\|assert.strictEqual(true" tests/*.js` → 0 命中：无恒真断言。
- 静态守卫未被削弱：`tests/capacity-settings.test.js:241-245`（`writeFile/writeFileSync/appendFile/appendFileSync/rename/renameSync/rmSync/unlink…` 调用点即违规）、`:286`（`open(`）、`:287-291`（具名 fs 导入只允许只读 API）、`:262`（动态 `import('node:fs`）、`:276-282`（`cordis.patch.yml` 出现在**代码行**即违规，纯注释行不算）、`:300-304`（client.js 连 `node:fs` 都不许引用）；并有自检 `:307-321`「违规样例必须红、合规样例必须绿（本守卫不是空断言）」与真实文件断言 `:354-360`。
- 严打清单其余项：`grep -rn "TODO\|FIXME\|XXX\|HACK" index.js client.js` → 0；全部 `catch` 站点审计 → index.js 36 处 catch 中无一空 catch，读失败路径统一 `onFailure(...)` + 去重 warn（`index.js:387-396`、`:493/500/509/513/520`），client.js 7 处被启发式标记的 catch 是订阅/句柄创建失败时的防御性置空（如 `client.js:868-879`），随后都有显式可用性判断，不是吞异常；实现类测试输入字符串（`需求文档`/`面板文案`/`round 2`）只出现在 `index.js:288-300` 的**注释**里，可执行代码无按输入分支的特判。

---

## 8. 回归未被破坏（我亲自跑的）

```
$ node --input-type=module -e "…resolveConfig({}) / resolveConfig(undefined) vs DEFAULT_CONFIG…"
resolveConfig({}) / (undefined) deepEqual DEFAULT_CONFIG: OK
DEFAULT_CONFIG keys=["enabled","mode","member","subagent","workspaces"] hasReviewer=false
DEFAULT_CONFIG={"enabled":true,"mode":"nested","member":{...},"subagent":{...},"workspaces":{}}
```

- `reviewer` 不在 `DEFAULT_CONFIG` 中，半残配置在解析阶段被丢弃；`tests/team-model-route.test.js:623`（RF3：两级都没配时 Lead 直系仍落 member、teammate 下级仍落 subagent，与引入 reviewer 前一致）与 `tests/model-route-config.test.js:455`（R4）在全量运行中通过。
- 面板三张卡仍在：`client.js:292-296` `ROUTE_GROUPS` = 成员模型 / 子代理模型 / 审查代码模型；`emptyHint` 参数与默认文案「留空则继承全局默认路由」仍在 `client.js:1267`、`:1274`；审查卡的「留空则回退」口径见 `docs/DELIVERY.md:57`。
- `grep -c "spawn_teammate" skills/*/SKILL.md` → 4 个文件全 `0`；4 个 SKILL.md frontmatter 仍合法（`name` kebab + `description`），`listPackagedSkillCandidates` 实测返回 4 条候选（`550 | custom | dsh-force-subagent`）。
- `README.md:83` / `docs/agent-team-api.md:352` / `index.js` 对 label 判据的三处描述互相一致（见 §1.3 对照表）；`index.js:674` 确实存在 README 声称的「审查代码的成员 / 子代理建议命名为 reviewer（如 name: "reviewer"）」提示。

---

## 9. 结论

- **D1**：真实修复。文档（`docs/agent-team-api.md:352`、`README.md:83`）与 `index.js:294/302/311-323` 逐字同口径（锚定 + `please` + 结尾或分隔符 + 两条判据 + 不做任意位置子串匹配 + 旧常量已删除）；`REVIEWER_LABEL_PHRASE_RE` 在全仓仅以「已删除/历史说明」身份出现 4 次，`grep -c "REVIEWER_LABEL_PHRASE_RE =" index.js` = 0；变异反证证明 R13/R14 可红。
- **D2**：真实修复。三处文档均补「跨层最近层直接胜出 / rank 只在同层决定重名 / 两者同在 global 层故 400 胜出」；宿主源码 `packages/skill/skill/src/index.ts:551-555`、`:556-563`、`:567-576`、`:345-352`、`:78` 与 `skill-filesystem/src/index.ts:38-39` 支持该说法；`docs/install.md:207-215` 的新自检步我已按原文跑通。遗留一条措辞作废问题（N1，非阻塞）。
- **D3**：真实修复。`client.js:312` 有真实 `isObject` 守卫、`draftIsValid`（:328-330）语义由 `invalidRouteLabel` 单一决定并与面板调用点（:995/:1203）一致；测试是把 `assert.throws(TypeError)` **改写**为合法断言（两文件 `assert.throws` 计数 0）；注掉守卫即变红（TypeError 实测），还原后 diff 空、md5 相同。
- **D4**：真实修复。`index.js:108-114` 注释与 `README.md:77`、`docs/agent-team-api.md:388` 均写明「同一配置位置每进程一次」；`warnedReviewerConfig` / `warnedSkillIssues` 无任何 `clear`/`delete`，去重口径仍由 `tests/model-route-config.test.js:400/417-418`、`tests/workspace-route.test.js:201` 锁住。
- **D5**：真实修复。38 条指定样例 + 24 条自选对抗样例全部符合要求（`failures=0`）；加回「宾语可选」分支后只有 R16 变红（663/1），且 R15/`:673-676` 证明收紧没有牺牲 code review 族与中文族。
- 全量测试：我自己跑的 `node --test tests/*.test.js` = **664 tests / 664 pass / 0 fail / 0 skipped / 0 todo**（292.09 ms）；含 `tests/verify` 为 682/682（299.19 ms）。测试真实、可红、无 skip、无恒真断言、静态守卫未削弱。
- 新发现：N1（P2，文档「本安装实测」措辞已被 2026-11-18 的 `~/.dsh/skills/team-*` → `~/.dsh/backups/skills-team-20261118-140511` 变更作废）、N2（P3，轮次编号必须为数字编号且位于结尾）、N3（P3，全量命令漏 `tests/verify` 的 18 个用例）。三者都不涉及糊弄、不改变代码正确性，属文档/口径精修。

**判据：D1–D5 全部经独立取证确认为真实修复，无硬编码迎合、无特判欺骗、无空 catch、无删断言或 skip 掩盖、无文档与代码矛盾；测试真实全绿。建议后续修 N1–N3 三处文档措辞（不涉及代码）。**

VERDICT: APPROVE
