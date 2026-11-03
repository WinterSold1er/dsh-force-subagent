# 对抗审查报告：dsh-force-subagent

- 审查员：reviewer（独立对抗审查，未修改任何实现代码，写范围仅本文件）
- 审查时间：2026-10-29 22:0x +08:00
- 环境：Linux，Node v26.9.0，DSH 0.2.1-rc.3（`/home/csy/Code/installer/deepseek-harness-0.2.1-rc.3`），profile `web`
- 审查对象：`index.js`(80)、`package.json`、`cordis.patch.yml`、`README.md`(50)、`tests/force-subagent.test.js`(213)、`scripts/install.sh`(300)、`docs/install.md`(202)、`docs/prompt-plugin-api.md`(250)、`docs/agent-team-api.md`(285) 及真实安装状态

## 0. 裁决依据与执行方式

- 按 `team-recursive-orchestration`：本轮派发 2 个只读 subagent（省略 provider/model，继承默认路由，未传 `reasoning_effort`）分别复跑测试与核对真实安装状态；两次均成功返回。**最终裁决全部基于本文中审查员本人亲自执行的命令与原始输出**，subagent 结果仅作交叉印证。
- 未直接运行真实 `./scripts/install.sh`（会改写真实 profile）。脚本行为用 `/tmp` 隔离 fixture 验证；真实 profile 上只执行 `--dry-run`，并用前后快照证明零落盘。
- 不修改任何实现文件；未执行 `git add`，未触碰工作区代码。

## 1. 必做复跑（审查员本人执行，原始输出）

### 1.1 测试套件

```console
$ cd /home/csy/Code/Github/dsh-force-subagent && node --test tests/*.test.js; echo "EXIT=$?"
✔ inject 依赖声明严格等于 [agents, agentTeams, systemPrompt] (1.84488ms)
✔ renderNudge 仅对 lead / teammate 返回含关键指令的文案，其余角色恒为空串 (4.163433ms)
✔ apply 为已存在 agent 注册唯一 section：名称固定、order 紧随 TEAM_POLICY (0.651542ms)
✔ agent/created 为新 agent 安装 section，同一 agent 重复触发只注册一次 (0.304577ms)
✔ text 每次求值都重新查询 membership，不缓存角色 (0.345064ms)
✔ 非团队 agent 仍注册 section，但 text() 渲染空串 (0.226708ms)
✔ 生命周期：disposed 幂等释放、effect 卸载全部剩余 section、卸载后可重新安装 (0.393252ms)
✔ text() 同步返回 string，且与 renderNudge 对同一角色的输出严格相等 (0.382193ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 101.124818
EXIT=0
```

### 1.2 模块导入与角色渲染

```console
$ node --input-type=module -e "import('./index.js').then(m=>console.log(JSON.stringify({inject:m.inject,lead:m.renderNudge('lead').length,teammate:m.renderNudge('teammate').length,other:m.renderNudge('x')})))"; echo "EXIT=$?"
{"inject":["agents","agentTeams","systemPrompt"],"lead":155,"teammate":119,"other":""}
EXIT=0
```

### 1.3 语法检查 + 真实 profile dry-run（零落盘验证）

```console
$ bash -n scripts/install.sh; echo "EXIT_BASHN=$?"
EXIT_BASHN=0

# before/after 快照：profile 顶层 package.json* + node_modules + 插件 symlink 的大小/mtime
$ ./scripts/install.sh --dry-run; echo "EXIT_DRYRUN=$?"
already linked: /home/csy/.dsh/profiles/web/node_modules/dsh-force-subagent -> /home/csy/Code/Github/dsh-force-subagent
would: no changes (already installed)
mode=install dry_run=true changed=0 backups=none
EXIT_DRYRUN=0

$ diff /tmp/before.txt /tmp/after.txt && echo 'NO_WRITES_CONFIRMED'
NO_WRITES_CONFIRMED
```

快照前后完全一致（`package.json` 仍为 1600 字节，mtime `1793281541.1614316460`；备份文件 `bak-20261028-183544`/`bak-20261029-214541` 未变；symlink 未变）。

### 1.4 git 与卫生扫描

```console
$ git status --porcelain
?? README.md
?? cordis.patch.yml
?? docs/
?? index.js
?? package.json
?? scripts/
?? tests/
$ git diff --stat        # 无 tracked 改动
$ ls -l scripts/install.sh index.js
-rwxr-xr-x 1 csy csy 9966 10月29日 21:46 scripts/install.sh
-rw------- 1 csy csy 3237 10月29日 21:21 index.js
$ grep -rInE 'api[_-]?key|secret|token|password|BEGIN (RSA|OPENSSH|PRIVATE)|ghp_|sk-[A-Za-z0-9]' --exclude-dir=.git .
./tests/force-subagent.test.js:85:    assert.ok(lead.includes(token), `lead 文案缺少 ${token}`)
$ grep -rInE 'TODO|FIXME|XXX|catch *\([^)]*\) *\{ *\}' --exclude-dir=.git .   # 无输出
```

结论：仓库内只有新增文件，无 secret、无 TODO/FIXME/空 catch。51 处 `/home/csy/...` 绝对路径全部出现在 docs/README（本机部署文档，非密钥），可移植性见 §4 R4。

### 1.5 真实安装状态（逐项核对）

```console
$ grep -c '"dsh-force-subagent"' ~/.dsh/profiles/web/package.json
2   # dependencies 1 条 + dsh.profile.bundles 1 条（node 计数：dependencies_count=1, bundles_count=1, bundles 长度 18）
$ ls -la ~/.dsh/profiles/web/node_modules/dsh-force-subagent
lrwxrwxrwx ... /home/csy/.dsh/profiles/web/node_modules/dsh-force-subagent -> /home/csy/Code/Github/dsh-force-subagent
$ readlink -f ...     # /home/csy/Code/Github/dsh-force-subagent（目标存在）
$ ls -la ~/.dsh/profiles/web/package.json.bak-20261029-214541
-rw-r--r-- 1 csy csy 1495 ... package.json.bak-20261029-214541   # 存在，且不含插件条目（= 安装前状态）
$ node .../apps/cli/lib/bin.js --profile web --dump-config | grep -n -A2 '^# == dsh-force-subagent'; echo EXIT=$?
1388:# == dsh-force-subagent
1389-- id: dsh-force-subagent
1390-  name: dsh-force-subagent
EXIT=0
```

`dump-config` stderr 仅重复出现既有无关告警 `patch: entry "llm-commandcode" not found`，与本插件无关；插件节点位于 bundle 装配区，形态与 `dsh-hide-clock` 一致。

### 1.6 测试真实性：6 处 /tmp 变异（把实现改坏，确认测试会红）

```console
M1 renderNudge 恒返回 lead 文案      -> exit=1  pass 5 fail 3  (renderNudge…/text 每轮…/text() 同步…)
M2 缓存角色（安装时求值一次）        -> exit=1  pass 6 fail 2  (text 每轮…/text() 同步…)
M3 非成员硬注入 lead 文案            -> exit=1  pass 5 fail 3  (非团队 agent…/text 每轮…/text() 同步…)
M4 inject 去掉 'agentTeams'          -> exit=1  pass 7 fail 1  (inject 依赖声明…)
M5 order 硬编码 600（不查表）        -> exit=1  pass 7 fail 1  (apply…order 紧随 TEAM_POLICY)
M6 删掉 agent/disposed 释放          -> exit=1  pass 7 fail 1  (生命周期…)
```

6/6 变异全部被捕获，证明断言可失败、非恒真；`renderNudge` 与 `apply` 均为真实调用（fake host 只实现契约签名，非 mock 掉被测逻辑）。

## 2. 硬性审查项逐条结论

| # | 项 | 结论 | 证据 |
| :-- | :--- | :--- | :--- |
| ① | 硬编码/测试特判/魔法常量 | PASS | 生产路径无分支特判；`order` 走 `getSectionOrder('TEAM_POLICY') + 1`（`index.js:46`），未写死 600；测试里 600 仅出现在 fake host（`tests:53`），非生产代码 |
| ② | 空 catch/TODO/静默失败/空值防御 | PASS | 全仓无 catch/TODO；`tryMembership === undefined` 严格按契约（`index.js:50`）；`release()` 对缺失 disposer 显式 return（`:58`）；`renderNudge` 用 `Object.hasOwn` + typeof 防原型名/非字符串（`:27`）。`ctx.agents.list()` 契约返回 `Agent[]`（rc.3 `packages/core/agent/src/index.ts:588`），`section()` 契约返回 disposer（`system-prompt/src/index.ts:478`），故无 undefined 分支可守 |
| ③ | 虚假测试 | PASS | 8 测试 44 断言，无 0 断言测试；6 变异全红；断言语义（inject 精确相等、order=601、disposer 计数、每轮重算次数=3）均可失败 |
| ④ | 违背契约 | PASS | inject 三元素精确（`:12`）；`agent.ctx.systemPrompt.section` 作用域注册（`:43`）；text 每轮 `tryMembership`（`:49`）；非成员空串（`:50`）；disposer + `ctx.effect` 卸载（`:56-79`）；order=TEAM_POLICY+1（`:46`）。已对照 rc.3 真值：`TEAM_POLICY: 600`（`system-prompt/src/index.ts:135`）、`filter(text => text.length > 0)`（`:293`）、`getSectionOrder`（`:494`）、`agent/disposed` 载荷 `{ agent }`（`core/agent/src/index.ts:516`）、上游同款 `ctx.effect(() => () => …)` 模式（`tool-agent-team/src/index.ts:422-431`） |
| ⑤ | 需求符合性 | PASS | lead 155 字符含 `team_task_create`/`spawn_teammate`/`wait_agent`（`index.js:17`）；teammate 119 字符含「编排者」+`subagent`/`subagent_fork`（`:18`）；非成员 `renderNudge('x')===''`（实测）；非 team 部署靠 inject 门禁不 apply（`:12`，cordon 契约；运行中 host 未重启，故仅接线级验证，见 R5） |
| ⑥ | 安装脚本安全性 | PASS（含 3 项非阻断缺陷） | 幂等：fixture 连跑两次 dep=1/bun=1，第二次 `changed=0`；备份：改动前 `copyFileSync` 并保留（真实 `bak-20261029-214541` = 安装前 1495 字节）；symlink 校验：外来链接/普通文件/悬垂链接全部 `exit=1` 拒绝替换（见 §3 矩阵）；`--uninstall` 只删自身条目与指向本仓库的链接，无关 `other-plugin` 依赖与 bundle 完好，二次卸载 `already uninstalled changed=0`；dry-run 零落盘（fixture 内容 `cmp` 一致、无 .bak/.tmp） |
| ⑦ | 文档与实现一致性 | PASS | README `./scripts/install.sh` 可执行（`+x`）；install.md 两条验证命令实测输出与文档逐字一致：`import.meta.resolve` → `file:///home/csy/Code/Github/dsh-force-subagent/index.js`；`m.inject` → `[ 'agents', 'agentTeams', 'systemPrompt' ]`；dump-config 区块与 `docs/install.md:98-101` 一致；风险章节如实标注「不热加载」「必须外部重启」「file: 绝对路径」「未验证路径不采用」，无吹牛 |

### 2.1 安装脚本对抗矩阵（隔离 fixture，原始结果）

```console
A dry-run 全新 fixture   exit=0 pkgFiles=1 content=UNCHANGED wouldLines=4   # 零落盘
B install 1/2            exit=0/0 dep=1 bun=1 val=file:/home/.../dsh-force-subagent
                         otherDep="^1.0.0" otherBundle=true order=[base, other-plugin, dsh-force-subagent]
                         backups=package.json.bak-20261029-220801
D uninstall 1/2          exit=0/0 剩余 deps={other-plugin, superpowers-dsh} bundles=[base, other-plugin]
                         symlinkLeft=NO；二次卸载 already uninstalled changed=0
F 外来 symlink            exit=1 refusing to replace it（目标 /tmp 保持不动，package.json 未改）
G 外来普通文件            exit=1 not a symlink; refusing to replace it（文件保留）
H 悬垂 symlink            exit=1 points to /nonexistent-xyz, expected …; refusing to replace it
I 非法 JSON              exit=1 profile package.json is not valid JSON
J PLUGIN_DIR 错误         exit=1
K profile 缺失            exit=1
L 未知参数                exit=2
```

## 3. 缺陷卡片

> 以下 3 项均为**非阻断**缺陷（无数据丢失、无静默失败、报错可见、重跑可收敛），不构成 REJECT 条件；建议返工单优化。

### R1（LOW）dry-run 报告了并不存在的备份文件

- 位置：`scripts/install.sh:205-207`（dry 模式仍 `BACKUPS+=(…bak-$TS)`）、`:294-300`（summary 打印）
- 反例：fixture 首次 dry-run 实测 `mode=install dry_run=true changed=2 backups=/tmp/.../package.json.bak-20261029-220800`，但目录内 `package.json*` 只有 1 个文件（无 .bak）——用户会去找一个不存在的备份。
- 复现：
  ```bash
  mkdir -p /tmp/r1/p/node_modules && echo '{"name":"p","dependencies":{},"dsh":{"profile":{"bundles":[]}}}' > /tmp/r1/p/package.json
  DSH_PROFILE_DIR=/tmp/r1/p ./scripts/install.sh --dry-run; find /tmp/r1/p -name 'package.json.bak-*'
  ```
- 建议：dry 模式下把 summary 改成 `backups=would-be:<path>` 或排除未创建项。

### R2（LOW）同一秒内连续两次「有变更」会静默覆盖上一份备份

- 位置：`scripts/install.sh:180-186`（`fs.copyFileSync(file, backup)`，未检查备份是否已存在）
- 机制：备份名仅精确到秒 `${file}.bak-${ts}`；同一秒内第二次有变更时覆盖第一份备份，丢失更早的「安装前」状态。
- 复现（构造性，依赖同秒两变）：修改 profile 使脚本需要变更 → 立即还原为另一「需要变更」的形态并再跑一次 → 只余一份 .bak。
- 说明：真实环境已有 `bak-20261028-183544`、`bak-20261029-214541` 两份秒级不同的备份，未受影响。
- 建议：备份已存在时加后缀（`-1`）或改用 `cp -n` 失败即报错。

### R3（LOW）安装失败时留下半成品 symlink（先建链、后改 JSON）

- 位置：`scripts/install.sh:278-280`（`install_symlink` 在 `edit_profile_json` 之前）、`:217-249`
- 反例（实测）：
  ```console
  # profile JSON 合法但结构非法：dsh.profile.bundles 为字符串
  DSH_PROFILE_DIR=/tmp/fsa-adv/shape ./scripts/install.sh; echo EXIT=$?
  created symlink /tmp/fsa-adv/shape/node_modules/dsh-force-subagent -> /home/csy/Code/Github/dsh-force-subagent
  error: /tmp/fsa-adv/shape/package.json: dsh.profile.bundles must be an array
  error: failed to edit /tmp/fsa-adv/shape/package.json (see error above)
  EXIT=1        # 此时 symlink 存在、dependency 未写入（半成品）
  ```
- 影响：不破坏既有内容、错误可见，修复 JSON 后重跑可收敛；但在「失败即无副作用」意义上不干净。
- 建议：把 JSON 编辑（含结构预校验）放在建链之前，或失败时回滚已建链接。

### R4（INFO）文档硬编码本机绝对路径，搬运即失效

- 位置：`README.md:22,27-29,40`；`docs/install.md:92,106,116,124,160-169,179,197-199`（共 51 处 `/home/csy/...`）
- 非密钥，仅可移植性：仓库移动/换机后文档命令与「变更清单」需同步改；`docs/install.md:187` 已如实标注 `file:` 绝对路径限制。
- 建议：README 用 `"$(git rev-parse --show-toplevel)"` 或占位符，install.md 保留本机实录但标注「示例路径」。

### R5（INFO）运行期「非 team 部署不 apply」未做宿主实机验证

- 依据：`index.js:12` 的 `inject` 含 `agentTeams`，Cordis 仅在服务就绪后调用 `apply`（`docs/prompt-plugin-api.md:180` 自己标注了 apply 时序属 UNVERIFIED）；本轮未重启 :3080，故只验证了接线（dump-config 节点 + 包解析 + 导出），未观测运行期「普通会话无注入」。
- 影响：属部署验证残留，不是代码缺陷；`docs/install.md:137` 已把「未重启故行为无变化」列为预期。
- 建议：重启后在一个普通会话与一个 agent-team 会话各做一次观测，补一条实测记录。

## 4. 需求符合性抽查（关键项）

| 需求 | 实测 | 结论 |
| :--- | :--- | :--- |
| lead 提示含 `team_task_create`/`spawn_teammate`/`wait_agent` | 155 字符，三者齐全（`index.js:17`） | PASS |
| teammate 提示含「编排者」+ `subagent` | 119 字符，`编排者`/`subagent`/`subagent_fork` 齐全（`:18`） | PASS |
| 非成员空串 | `renderNudge('x')===''`；`text()` 对 `tryMembership===undefined` 返回 `''`（`:50`） | PASS |
| 仅 team 部署生效 | `inject` 三元素门禁（`:12`）；运行期观测见 R5 | PASS（接线级） |
| 空串不注入 | rc.3 `renderPrompt` `.filter(text => text.length > 0)`（`system-prompt/src/index.ts:293`） | PASS |
| 每轮重算、不缓存角色 | 单测「membershipCalls.length === 3」+ 变异 M2 被杀 | PASS |
| order = TEAM_POLICY + 1 | 单测 601；`getSectionOrder('TEAM_POLICY')` 取表；变异 M5 被杀 | PASS |
| 安装后 profile 恰好各 1 条 | `dependencies_count=1, bundles_count=1`（真实 profile） | PASS |
| dump-config 出现插件节点且 exit 0 | `1388-1390`，`EXIT=0` | PASS |

## 5. 结论

实现与契约（含 rc.3 真值源码）一致，测试真实可失败（6/6 变异全红），安装脚本在幂等、备份、symlink 校验、卸载不破坏无关内容、dry-run 零落盘上均通过对抗矩阵；未发现硬编码、空 catch、静默失败、虚假测试或契约违背。3 项非阻断缺陷（R1/R2/R3）与 2 项信息项（R4/R5）建议后续优化，不改变本次结论。

VERDICT: APPROVE
