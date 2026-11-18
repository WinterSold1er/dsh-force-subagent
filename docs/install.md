# dsh-force-subagent 安装与启用

用 `/using-agent-team` 命令按会话开启强制委派提示（`systemPrompt.section`，order 57），`off` 关闭；依赖宿主 `commands` 与 `systemPrompt` 服务。

## 前置条件

- Node.js `^22.19.0 || >=24.0.0`（本机 v26.9.0）。
- DSH `>=0.2.1-rc.1`。真实宿主为 `/home/csy/Code/installer/deepseek-harness-0.2.1-rc.3`（0.2.1-rc.3）。
- 插件仓库：`/home/csy/Code/Github/dsh-force-subagent`（0.1.0，零依赖 ESM，无需构建）。
- profile：`/home/csy/.dsh/profiles/web`（web host 在 :3080 运行）。
- 备份：任何被改文件先复制为 `<原文件>.bak-<YYYYmmdd-HHMMSS>`，确认无需回滚前不要删除。
- 验证必须用 rc.3 的 CLI 全路径：`dsh` shim 指向 alpha.4 的另一棵树，不能用它验证本 profile。

## 一键脚本

```bash
cd /home/csy/Code/Github/dsh-force-subagent

./scripts/install.sh --help       # 用法说明
./scripts/install.sh --dry-run    # 预演：只打印将做的改动，不落盘
./scripts/install.sh              # 安装并接线
./scripts/install.sh --uninstall  # 卸载（保留备份）
```

脚本行为：

1. 仅在确有改动时，把 `~/.dsh/profiles/web/package.json` 备份为 `package.json.bak-<YYYYmmdd-HHMMSS>`；`--dry-run` 不写盘、不备份；安装与卸载各备份一次。
2. 在 profile `package.json` 的 `dependencies` 写入 `"dsh-force-subagent": "file:/home/csy/Code/Github/dsh-force-subagent"`，并把 `"dsh-force-subagent"` 追加到 `dsh.profile.bundles`。
3. 创建符号链接 `~/.dsh/profiles/web/node_modules/dsh-force-subagent` → `/home/csy/Code/Github/dsh-force-subagent`。
4. **不重启 host**（见下文）。

脚本幂等：重复执行不会产生重复依赖、重复 bundle 项或重复链接；无变化时输出 `changed=0` 与 `already installed`/`already uninstalled`。链接已存在但指向别处时脚本报错退出，不会覆盖。

可用环境变量覆盖路径：`PLUGIN_DIR`（默认脚本所在仓库根）、`DSH_PROFILE_DIR`（默认 `$HOME/.dsh/profiles/web`）、`DSH_NODE`（默认 `node`）。

## 手动步骤（等价于脚本）

### 1. 备份

```bash
P=/home/csy/.dsh/profiles/web
TS=$(date +%Y%m%d-%H%M%S)
cp -p "$P/package.json" "$P/package.json.bak-$TS"
echo "backup: $P/package.json.bak-$TS"

# 只记录链接现状，不删除：后续步骤会校验指向
ls -l "$P/node_modules/dsh-force-subagent" 2>/dev/null || echo "no existing symlink"
```

本流程只修改 `package.json`；`cordis.patch.yml` 不写入，无需备份。

### 2. 写入 dependencies 与 bundles

用 JSON 解析改写，**不要用 sed 直接替换文本**（sed 会破坏 JSON 结构或产生重复键）：

```bash
node -e 'const fs=require("fs");const p="/home/csy/.dsh/profiles/web/package.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));j.dependencies??={};j.dependencies["dsh-force-subagent"]="file:/home/csy/Code/Github/dsh-force-subagent";j.dsh??={};j.dsh.profile??={};const b=(j.dsh.profile.bundles??=[]);if(!b.includes("dsh-force-subagent"))b.push("dsh-force-subagent");fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")'
```

效果：`dependencies` 增加一项；`bundles` 末尾追加一项；重复执行结果不变。`bundles` 里的 id 决定 host 启动时是否装配该 bundle。

### 3. 创建 node_modules 符号链接

```bash
P=/home/csy/.dsh/profiles/web
S=/home/csy/Code/Github/dsh-force-subagent
L="$P/node_modules/dsh-force-subagent"
if [ -L "$L" ]; then
  [ "$(readlink -f "$L")" = "$S" ] || { echo "链接已存在但指向 $(readlink -f "$L")，人工确认后再处理" >&2; exit 1; }
  echo "链接已正确指向 $S"
elif [ -e "$L" ]; then
  echo "$L 已被实体路径占用，先确认来源，不要直接删除" >&2; exit 1
else
  ln -s "$S" "$L"
  echo "已创建 $L -> $S"
fi
```

链接的作用是让 Node 解析包名 `dsh-force-subagent`。**已存在时必须先校验指向**；指向别处说明可能属于其它部署，先人工确认，不要直接删。

### 4. 验证与重启

先做下一节的验证，再由用户手动重启 host；本流程不自动重启。


> **前置依赖：先跑 `./scripts/install.sh` 建立 `@deepseek-ai/schemastery` 软链。** 插件用它在 `index.js` 里声明 `Config`（根 `volatile`）；**软链缺失时插件加载即失败**（`ERR_MODULE_NOT_FOUND`），宿主不会启动本插件。脚本是幂等的，可重复执行。

## 验证（不重启、不启动新服务）

`--dump-config` 是一个全新的 CLI 进程，读取 profile 并装配 bundle，因此能在重启前验证接线是否正确；它不能证明运行中的 :3080 进程已加载插件（那需要重启）。

### 1. 查看配置中的插件节点

```bash
node /home/csy/Code/installer/deepseek-harness-0.2.1-rc.3/apps/cli/lib/bin.js --profile web --dump-config
```

期望在输出中看到（同一 `# == dsh-force-subagent` 区块下，与既有 `dsh-hide-clock` 形态一致）：

```
# == dsh-force-subagent
- id: dsh-force-subagent
  name: dsh-force-subagent
```

### 2. 快速定位

```bash
node /home/csy/Code/installer/deepseek-harness-0.2.1-rc.3/apps/cli/lib/bin.js --profile web --dump-config | grep -n -A2 '^# == dsh-force-subagent'
```

`-n` 会在每行前加行号，行号随 profile 变化；无输出（退出码 1）说明未装配，按排查表处理。

### 3. 包解析自检

从 profile 目录按包名导入，验证符号链接：

```bash
cd /home/csy/.dsh/profiles/web && node --input-type=module -e "console.log(import.meta.resolve('dsh-force-subagent'))"
```

期望：`file:///home/csy/Code/Github/dsh-force-subagent/index.js`

直接导入插件入口，验证导出：

```bash
node --input-type=module -e "import('/home/csy/Code/Github/dsh-force-subagent/index.js').then(m=>console.log(m.inject))"
```

期望：`[ 'commands', 'systemPrompt', 'subagents', 'tools' ]`（若看到 `agentTeams` 或缺少 `subagents`，说明加载的是旧版，需重启 host）。其中 `tools` 是能力探测的软依赖：缺失时按探测失败降级（standard 档文案 + 每次 apply 一条 warn），不阻塞 apply。

### 4. 失败排查

| 现象 | 处理 |
| :--- | :--- |
| `dump-config` 中无 `# == dsh-force-subagent` | 检查 `dependencies` 是否写入、`dsh.profile.bundles` 是否含该 id、symlink 是否创建；重跑脚本。 |
| `Cannot find package 'dsh-force-subagent'` | symlink 缺失或断开：`ls -l "$P/node_modules/dsh-force-subagent"`，重跑脚本。 |
| 报 engines 不兼容（需 dsh >= 0.2.1-rc.1） | 升级 DSH；不要改插件的 `engines`。 |
| `dsh: [.../cordis.patch.yml] patch: entry "..." not found` | profile 中其它 patch 的既有告警（例如 `llm-commandcode`），与本插件无关；不影响本插件区块出现。 |
| 运行中的 :3080 行为无变化 | 属预期：未重启，见下一节。 |

### 5. 全量测试（仓库侧验收，不依赖宿主进程）

```bash
cd /home/csy/Code/Github/dsh-force-subagent
node --test "tests/**/*.test.js"
```

期望：`ℹ tests 682`、`ℹ pass 682`、`ℹ fail 0`。全量口径含 `tests/verify/`（`using-agent-team.test.js` 的 18 个契约用例），当前基线 **682 tests 起**（只增不减）。旧写法 `node --test tests/*.test.js` 只覆盖 664 个用例，会把 `tests/verify/` 漏在口径外。

## 生效：必须手动重启 host

> **警告：profile 的依赖与 bundle 不会热加载。** 它们在 host 启动时装配，运行中的 :3080 进程不会读取新配置。安装或卸载后，只有重启 host 才生效。仅改浏览器侧 `client.js` 属例外：client-hmr 会自动重建并重跑 `apply`，无需重启。
>
> **重启会终止当前 agent 会话**（当前工具调用由该 host 托管）。务必在会话外的外部终端或独立进程中操作，不要在本 agent 会话内直接重启。本仓库脚本故意不重启，重启方式由你按部署自行决定；本环境提供的 `restarting-dsh-host-service` skill 说明了在宿主 cgroup 内以 detached 方式重启的做法，可参考。不要臆测 systemd 单元名。

重启后，在任意会话执行 `/using-agent-team`（或 `on` / `<task>`），之后的轮次都会带上 `force-subagent:agent-team` 系统提示词 section；执行 `off` 后消失。若未出现，先确认 host 已重启，再确认 `commands`、`systemPrompt` 两个服务已加载（缺失时插件会 warn 并停用）。

## 卸载与回滚

脚本卸载：

```bash
cd /home/csy/Code/Github/dsh-force-subagent
./scripts/install.sh --uninstall
```

手动卸载三步：

```bash
# 0) 备份（脚本卸载时会自动做）
P=/home/csy/.dsh/profiles/web
cp -p "$P/package.json" "$P/package.json.bak-$(date +%Y%m%d-%H%M%S)"

# 1) 移除 dependency 与 bundles 项
node -e 'const fs=require("fs");const p="/home/csy/.dsh/profiles/web/package.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));if(j.dependencies)delete j.dependencies["dsh-force-subagent"];const b=j.dsh?.profile?.bundles;if(Array.isArray(b))j.dsh.profile.bundles=b.filter(x=>x!=="dsh-force-subagent");fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")'

# 2) 仅当链接指向本仓库时删除
L=/home/csy/.dsh/profiles/web/node_modules/dsh-force-subagent
S=/home/csy/Code/Github/dsh-force-subagent
if [ -L "$L" ] && [ "$(readlink -f "$L")" = "$S" ]; then rm "$L"; fi
```

3. 重启 host（同上，会话外操作）。

备份按时间戳区分：`--uninstall` 在改动前又写一份 `package.json.bak-<TS>`，该份保存的是“已安装”状态；要撤销卸载，恢复最新一份备份即可。脚本不会删除任何备份。

回滚：备份文件 `<原文件>.bak-<YYYYmmdd-HHMMSS>` 保留不删，需要时覆盖回去：

```bash
cp -p /home/csy/.dsh/profiles/web/package.json.bak-<TS> /home/csy/.dsh/profiles/web/package.json
```

卸载同样需要重启才生效；脚本不会删除备份。

## 内置 skills（安装后自动出现，无需手工拷贝）

插件自带 4 个 team 技能：`team-adversarial-gatekeeper`、`team-lead-delegation`、`team-parallel-dispatch`、`team-recursive-orchestration`。重启 host 后它们直接出现在技能列表，**不需要**手工拷贝到 `~/.dsh/skills`，也不需要往 profile 里加任何东西：`package.json` 的 `files` 已包含 `skills`，插件加载时通过宿主 `skills` 服务的 `registerProvider` 从本包 `skills/<name>/SKILL.md` 按需只读加载（`provider = 'dsh-force-subagent'`、`source = 'custom'`、`rank = 550`）。

自检（不重启、不启动新服务）：

```bash
cd /home/csy/.dsh/profiles/web && node --input-type=module -e "import('/home/csy/Code/Github/dsh-force-subagent/index.js').then(async m=>console.log((await m.listPackagedSkillCandidates(m.PACKAGED_SKILLS_ROOT)).map(s=>[s.name,s.rank,s.source,s.provider].join(' | ')).join('\n')))"
```

期望（4 行，顺序按目录枚举）：

```text
team-adversarial-gatekeeper | 550 | custom | dsh-force-subagent
team-lead-delegation | 550 | custom | dsh-force-subagent
team-parallel-dispatch | 550 | custom | dsh-force-subagent
team-recursive-orchestration | 550 | custom | dsh-force-subagent
```

- 这条自检只证明「本包能发现这 4 条候选」；它们是否出现在会话的技能列表取决于宿主 `skills` 服务是否加载。宿主没装 skill 层（headless 组合）时这 4 条不出现，插件不抛也不 warn，门禁与委派提示照旧。
- **确认命中来源（第二步自检）**：上一步不说明宿主最终取哪一份。宿主合并后的每条技能都带 `source` 与 `path`（`packages/skill/skill/src/index.ts` 的 `SkillSummary`），比对其余层同名条目即可判定命中来源：

  ```bash
  # 1) ~/.dsh/skills 里是否存在同名拷贝、是不是 rc.1 旧版（签名词 spawn_teammate / pull-based）
  ls -d ~/.dsh/skills/team-* 2>/dev/null
  grep -l "spawn_teammate" ~/.dsh/skills/team-*/SKILL.md 2>/dev/null
  # 2) 随包版本的签名词（batched subagent / board-driven）
  grep -c "batched subagent\|board-driven" /home/csy/Code/Github/dsh-force-subagent/skills/team-parallel-dispatch/SKILL.md
  ```

  判读：第 1 步有输出 = `~/.dsh/skills` 存在同名旧拷贝，按下一条《重名优先级》的条件式结论（两者同在 global 层时 400 更小），会话里命中的是那一份（`list()` 结果的 `path` 会指向 `~/.dsh/skills/<name>/SKILL.md`、`source` 为 `user-dsh`）；要用随包版本就手工删掉或更新它。若 `list()` 结果的 `path` 指向 `/home/csy/Code/Github/dsh-force-subagent/skills/<name>/SKILL.md`、`provider` 为 `dsh-force-subagent`，才说明取到的是随包版本。按当前状态（旧拷贝已迁移，见下一条）第 1 步应当无输出、命中随包版本。
- **重名优先级（层口径，不是纯 rank）**：宿主 skill registry 的真实契约是「跨层由最近的一层直接胜出，`rank` 只在同一层内决定重名」（`packages/skill/skill/src/index.ts` 的 `collectFresh` 注释：「the nearest layer's same-name entry replaces the farther ones … Rank decides duplicates only within one layer」）。provider 落在哪一层由它挂在哪决定（挂在 agent preset 的 standing composition 上就落在该 preset 层）。宿主常量 `USER_DSH_RANK = 400`、`USER_AGENTS_RANK = 500`、`BUNDLED_SKILL_RANK = 600` 只用于各自层内的重名比较，不能跨层排序。条件式结论（不是无条件事实）：若本插件 provider 与 `~/.dsh/skills`（宿主 `user-dsh` 根）**同在 global 层**，同层比 rank，则 `~/.dsh/skills` 的同名条目（400）胜过本插件（550），本插件（550）胜过同层的 bundled 根（600）。当前实际状态（2026-11-18 14:05 起）：`~/.dsh/skills/team-*` 四份旧拷贝已迁移到 `~/.dsh/backups/skills-team-20261118-140511/`，`~/.dsh/skills` 已无同名条目，因此当前命中的是随包 provider（550），上面自检的第 1 步现在应当无输出；若日后把旧拷贝放回 `~/.dsh/skills`，同层按 rank 400 胜出。若 `~/.dsh/skills` 里还留着同名旧拷贝（例如仍写 `spawn_teammate` 的 rc.1 版），命中的是那一份；要用随包版本，需手工删除或更新 `~/.dsh/skills/<name>`，插件不会替你删。反过来，若某台宿主上本插件 provider 落在更近的层，同名会由本插件胜出，与 550 / 400 的大小无关。
- 正文按需只读加载：改 `skills/<name>/SKILL.md` 后，由宿主下一次刷新技能目录或加载该技能时读到新内容；若宿主缓存了候选列表，重启 host 即刷新。不需要重装，也不涉及 `pnpm install`。
- 卸载插件后这 4 条随插件 scope 一起注销；`~/.dsh/skills` 里若没有你自己放的同名技能，无需手工清理。

## 风险与限制

- **热加载只覆盖浏览器半边**：安装、卸载、改宿主侧 `index.js` 后必须重启 host；只改 `client.js` 由 client-hmr 自动重建并重跑 `apply`，通常无需重启（见 README §部署）。
- **`file:` 依赖是绝对路径**：仓库移动或改名后，`dependencies` 与 symlink 都会失效，需改路径后重跑脚本。
- **symlink 与 `pnpm install`**：本仓库不运行 `pnpm install`。若你自行在 profile 里运行，pnpm 可能重写 `node_modules`，链接可能丢失或变成实体副本；恢复方式是重跑 `./scripts/install.sh`。
- **改插件源码无需重装**：symlink 直连仓库，改宿主侧 `index.js` 后重启 host 即生效，改浏览器侧 `client.js` 走 client-hmr 无需重启；但仓库移动仍需重跑脚本。
- **开关按会话、可追溯**：门控直接派生自会话内的 `command/run` 事件，执行命令后的下一轮即生效，无需等新消息批次；重启后仍存活或恢复的会话只要事件还在，就继续注入。
- **注入范围**：插件只在**执行过 `/using-agent-team`** 的会话注入（`on` / `<task>` 同样算开启，`off` 关闭）；未执行命令的会话不注入。`commands` 或 `systemPrompt` 服务缺失时插件 warn 并停用（无任何注入）。
- **engines 门禁**：DSH 低于 `0.2.1-rc.1` 时不要改插件绕过，升级宿主。

## 变更清单

| 路径 | 动作 | 说明 |
| :--- | :--- | :--- |
| `/home/csy/.dsh/profiles/web/package.json` | 修改 | `dependencies` 增加 `"dsh-force-subagent": "file:/home/csy/Code/Github/dsh-force-subagent"`；`dsh.profile.bundles` 末尾追加 `"dsh-force-subagent"` |
| `/home/csy/.dsh/profiles/web/node_modules/dsh-force-subagent` | 新建符号链接 | → `/home/csy/Code/Github/dsh-force-subagent` |
| `/home/csy/.dsh/profiles/web/package.json.bak-<YYYYmmdd-HHMMSS>` | 备份 | 脚本或手动步骤自动生成 |
| `/home/csy/Code/Github/dsh-force-subagent/cordis.patch.yml` | 不修改 | 由插件 `package.json` 的 `dsh.bundle.patch` 随 bundle 自动应用（`insert: id/name`） |
| `~/.dsh/skills` | 不需要写入 | 4 个内置 skills 由插件经宿主 `skills.registerProvider` 从本包 `skills/` 注册（`package.json` 的 `files` 已含 `skills`），不经目录拷贝 |

不修改插件源码、不写 profile 的 `cordis.patch.yml`、不运行 `pnpm install`、不重启任何服务。
