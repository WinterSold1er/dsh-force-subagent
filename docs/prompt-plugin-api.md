# DSH prompt/plugin API 契约

TL;DR：零构建纯 ESM host 插件可行，`apply`/`inject` 是官方契约；`systemPrompt.section()` 的 `text` 函数**每个 turn 都会被重新求值**，因此动态判定 team 角色无需注册/销毁 section；**`AssembleContext` 不含 `agent` 字段**，per-agent 差异只能靠闭包——在 `agent.ctx` 作用域内注册 section，并在 text 回调里查询该 agent 的团队身份（`packages/experimental/tool-agent-team/src/index.ts:169`）。非 team agent 的注入实现为「永远注册一个 section，其 text 返回 `''`」：空字符串在渲染前被 filter 掉，不产生任何残留（`packages/core/system-prompt/src/index.ts:293`、`:296`、`:336`）。

## 1. 运行时标识（权威来源）

宿主进程 = `/home/csy/Code/installer/deepseek-harness-0.2.1-rc.3`（PID 3170429，`/proc/<pid>/cwd` 与 `systemctl --user show deepseek-harness.service -p WorkingDirectory -p ExecStart` 的 `WorkingDirectory=` 均为 rc.3；`ExecStart` 同）。unit 文件 `FragmentPath=/home/csy/.config/systemd/user/deepseek-harness.service`，`Environment=DSH_HOME=/home/csy/.dsh`，监听 127.0.0.1:3080。

| 树 | 路径 | `@deepseek-ai/*` 版本 | `dsh --version` | 角色 |
|---|---|---|---|---|
| 宿主 rc.3 | `/home/csy/Code/installer/deepseek-harness-0.2.1-rc.3` | 26× `0.2.1-rc.3` | — | **契约权威** |
| `dsh` shim | `/home/csy/Code/installer/deepseek-harness` | 26× `0.2.1-alpha.4` | `0.2.1-alpha.4` | 仅交叉验证 |

rc.3 的 `node_modules/@deepseek-ai/*` 是指向 `packages/*` 的符号链接（workspace 构建），故 rc.3 的 `src/` 即真实运行代码来源。**规则：读契约只看 rc.3，shim 树只用于交叉验证。**

`engines.dsh` 门禁真实生效：`/home/csy/.dsh/profiles/web/node_modules/dsh-plugin-subagent-director/package.json:154` 声明 `"dsh": ">=0.2.1-rc.1"`；alpha.4 shim 以原文拒绝——`Plugin dsh-plugin-subagent-director@0.6.0-beta.3 is incompatible with dsh 0.2.1-alpha.4: requirements {"engines.dsh":">=0.2.1-rc.1"}`；rc.3 接受该插件。

## 2. 插件入口契约（零构建 ESM）

参照实现：`/home/csy/.dsh/profiles/web/node_modules/dsh-hide-clock`。实际发布物是**裸 JS**，无 `dist/`、无构建配置、无 `dependencies`。其 `index.js:2` 仅一行 `export function apply() {}`，即为合法 host 插件。

最小 `package.json` 必需字段（逐项带证据）：

```json
{
  "type": "module",                                              // dsh-hide-clock/package.json:6
  "exports": { ".": "./index.js" },                              // :7
  "files": ["index.js", "cordis.patch.yml"],                     // :14
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }                  // :24 / :25
  },
  "engines": {
    "node": "^22.19.0 || >=24.0.0",                              // :47
    "dsh": ">=0.2.1-rc.1"                                        // dsh-plugin-subagent-director/package.json:154
  }
}
```

说明：
- `dsh.client`（`"platform": "web"`, `"immediately": true`, `"inject": [...]`，`dsh-hide-clock/package.json:27-29`）只服务其 client 半边；**纯 host 插件不写 `dsh.client`**。
- host 插件必须导出 `apply(ctx)`；`inject` 可选。上游双证：`packages/experimental/tool-agent-team/src/index.ts:14`（`export const inject = ['agents','agentTeams','tools','systemPrompt']`）与 `/home/csy/.dsh/profiles/web/node_modules/dsh-plugin-subagent-director/lib/index.js:14`（`export const inject = ['tools','subagents','llm','settings']`），两者 `apply` 分别在 `:411` 与 `lib/index.js:15`。
- **结论：零构建纯 ESM host 插件是既有且受支持的模式。**

## 3. 启用机制

两条路径，均要求 profile `package.json` 的 `dependencies` 有条目（`dependencies` 键见 `/home/csy/.dsh/profiles/web/package.json:4`）。

`cordis.patch.yml` 最小 insert 格式（`/home/csy/.dsh/profiles/web/node_modules/dsh-hide-clock/cordis.patch.yml:1-3` 逐行原样）：

```yaml
- insert:
    - id: dsh-hide-clock
      name: dsh-hide-clock
```

**路径 A：自带 bundle**（hide-clock 式）。依赖 `package.json:9` = `"dsh-hide-clock": "file:/home/csy/Code/Github/dsh-hide-clock"`；`dsh.profile.bundles` 收录于 `:38`；包内自带 `dsh.bundle.patch`。
**路径 B：显式 profile patch**（director 式）。依赖 `package.json:12` = `github:WinterSold1er/dsh-plugin-subagent-director#f31c7f5…`；`bundles` 收录于 `:29`；另需 profile `cordis.patch.yml` 的 `id/name/config` 条目（`/home/csy/.dsh/profiles/web/cordis.patch.yml:222-227`）：

```yaml
- id: subagent-director
  name: dsh-plugin-subagent-director
  config:
    defaultProvider: minor-5090
    defaultModel: qwen3.8-flash-next-iq3_xxs
```

禁用形式（profile patch，`/home/csy/.dsh/profiles/web/cordis.patch.yml:220-221`）：

```yaml
- id: cloudcode-link
  disabled: true
```

`~/.dsh/cordis.patch.yml` **最后应用**，可覆盖/禁用 profile 条目。
命令行便捷方式 `dsh plugin --profile web add link:<repo>`：UNVERIFIED（本轮 recon 未验证）— 解除方法：在 rc.3 树对 `dsh plugin` 子命令 `--help` 实测一次入口语义。

## 4. `systemPrompt.section` / `context` 精确签名

包 `@deepseek-ai/dsh-system-prompt@0.2.1-rc.3`，源码真值 `packages/core/system-prompt/src/index.ts`（691 行），service key 为 `systemPrompt`（`:446` `super(ctx, 'systemPrompt')`，类声明 `:429`）。

```ts
// packages/core/system-prompt/src/index.ts:53
interface PromptSection {
  name: string        // 唯一；重复注册抛错
  order: number       // 必须有限；非有限抛错；升序，同名次按 code-unit 名序
  text: string | ((context: AssembleContext) => string)  // 同步，不可 Promise
  interpolate?: boolean  // 默认 true，插值 {{variable}}
  complete?: boolean     // 成为唯一 system prompt；>1 个 active complete 抛错
}

// :79
interface PromptContext {
  name: string
  order: number
  text: string | ((context: AssembleContext) => string)  // ":84 静态文本或在装配与准入刷新时求值的 provider"
  interpolate?: boolean
  required?: boolean
}
// 文档明示："Empty text contributes nothing."（:79）
```

| 成员 | 签名 | 语义与证据 |
|---|---|---|
| `section()` | `(section: PromptSection) => () => void` | `:478`。注册进**调用者 context 的作用域**；同层重名抛错；作用域 section 以同名遮蔽全局；注册与 dispose 均发 `system-prompt/change` |
| `context()` | `(context: PromptContext) => () => void` | `:513`。作用域规则同上 |
| `getSectionOrder()` | `(name: PromptSectionOrderName) => number` | `:494`。**禁止硬编码 600** |
| `getContextOrder()` | `(name: PromptContextOrderName) => number` | `:503` |
| `assemble()` | `(context?: AssembleContext) => Promise<PromptAssembly>` | `:614`。返回值形状 `:124 interface PromptAssembly { sections; contexts; tools; variables }` |

`SECTION_ORDERS` 关键值（`:124-140`）：`HARNESS_IDENTITY: -1000`、`DEPLOYMENT_PERSONA_PREFIX: 0`、`PLAN_POLICY: 500`、`TEAM_POLICY: 600`、`PTC_ONLY: 800`、`FILE_REFERENCE: 900`、`TOOL_BASH: 1000`。

求值点：`:662` `text: typeof section.text === 'function' ? section.text(context) : section.text`；context provider 同构逻辑在 `:383`（装配与准入刷新各一次）。**结论：text 提供者在每次 assemble（即每 turn/请求）都被调用，返回随时间变化的文本是受支持的官方机制。**

## 5. `AssembleContext` 与动态求值

```ts
// packages/core/system-prompt/src/index.ts:42
interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal }
```

**此结构没有 `agent` 字段。** 后果：section 的 text 回调无法从入参得知当前是哪个 agent，任何「按角色给不同提示词」的逻辑都不能写在 text 回调的参数里，只能靠闭包捕获 agent（见 §7）。这不是实现疏漏，而是上游对同一问题的处理方式——上游在 agent 作用域注册并闭包 `agent`，再在回调体内查询 `ctx.agentTeams.membership(agent)`。

## 6. 空字符串行为（结论）

**SAFE。** 渲染链路：

- `:290` `renderPrompt(assembly)`
- `:293` `.filter(text => text.length > 0)` —— **filter 在 join 之前**
- `:296` `.join('\n\n')`
- `:336` `renderContextSections(...)`：`.filter(section => section.text.length > 0)`
- `:289` 文档：全空 section 渲染结果为 `''`

即：text 求值为 `''` 的 section 被**完全剔除**——无空标题、无空块、无多余分隔符。

**实现后果（一行）：** 全程只注册一次 section，非 team agent 返回 `''` 即可，无需 dispose/重新注册，也不产生任何 prompt 残留。

## 7. 每-agent 作用域 vs 全局注册

上游范式（`packages/experimental/tool-agent-team/src/index.ts`）：`apply` 在 `:411`，按 agent 安装与事件接线如下。

```ts
// :411
export function apply(ctx: Context, config: Config = {}): void {
  const installed = new Map<Agent, () => void>()                      // :417
  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === undefined) return  // :419
    installed.set(agent, install(agent, ctx, resolved))               // :420
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)          // :422
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })     // :423
  ctx.on('agent/disposed', ({ agent }) => { /* 释放 */ })              // :424
}

// :168
function install(agent: Agent, ctx: Context, config: Required<Config>): () => void {
  const scoped = agent.ctx                                            // :169
  const register = (d: () => unknown) => { disposers.push(d) }         // :171
  register(scoped.systemPrompt.section({
    name: 'team:policy',
    order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),         // :175 —— 不写 600
    text: teamPolicy(config.interrupt),                               // :176
  }))                                                                  // :173
  register(scoped.systemPrompt.context({
    name: 'team:identity',
    order: scoped.systemPrompt.getContextOrder('TEAM_IDENTITY'),      // :180
    required: true,
    text: () => { const { role } = ctx.agentTeams.membership(agent); /* lead / teammate */ },  // :182
  }))                                                                  // :178
}
```

**为什么全局注册无法按 agent 变化**：全局注册的函数在 `assemble()` 时拿到的只有 `AssembleContext`（`{scope?, signal?}`，`:42`），没有 agent 身份；且全局层只有一个同名 section 实例，多 agent 共享同一份文本。因此按 agent 差异化必须落到 **agent 自己的 `agent.ctx` 作用域**。

配套事实：`ctx.agentTeams.tryMembership(agent)` 返回 `TeamMembership | undefined`（`packages/experimental/agent-team/src/index.ts:219`），`membership(agent)` 返回 `TeamMembership`（同文件 `:116`）；agent 生命周期事件由 `packages/core/agent/src/index.ts` 派发——`register(agent)` `:439`、`agent/disposed` 派发 `:516`、`agent/created` 派发 `:552`。反向确认：上游把缺失 agent 当编程错误而非降级（`tool-agent-team/src/index.ts:161-166`，`throw new Error(\`${toolName} requires a calling Agent\`)`）。

## 8. `inject` 门禁语义

`inject` 是本插件声明的前置服务清单；声明的服务存在后 `apply` 才会被调用。上游正是用它做 team 门禁：`packages/experimental/tool-agent-team/src/index.ts:14` 注入 `agentTeams`，无 `agentTeams` 则该插件整体不生效。我方插件同理——注入 `agentTeams` 使「未启用 agent-team 的环境」直接跳过本插件，无需自写开关。

**语义边界（诚实标注）**：`apply` 在注入服务就绪后执行这一步为契约常识；但 cordis 调度器「按声明顺序/依赖图何时调用 `apply`」的具体细节本轮未逐行核对 — UNVERIFIED: cordis 的 inject 就绪判定与 apply 调用时序 — 解除方法：读 `node_modules/@deepseek-ai/dsh-cordis/lib/*.js` 中 `inject` 等待实现，或在插件里打点 `apply` 首次执行时间与 `agent/created` 首事件先后。

## 9. 最小插件入口骨架（≤15 行，非最终实现）

```js
export const inject = ['agents', 'agentTeams', 'systemPrompt']      // tool-agent-team/src/index.ts:14
// ★ agents 用于 list()/agent 事件，agentTeams 用于 nudge() 内查 membership —— 三者都必须在 inject 里
export function apply(ctx) {
  const installed = new Set()
  const install = (agent) => {
    if (installed.has(agent)) return                                // 重名 section 会抛：system-prompt/src/index.ts:53
    installed.add(agent)
    agent.ctx.systemPrompt.section({                               // 作用域注册：tool-agent-team/src/index.ts:169
      name: 'force-subagent:nudge',
      order: agent.ctx.systemPrompt.getSectionOrder('TEAM_POLICY'), // :175 / getSectionOrder :494
      text: () => nudge(agent),                                    // 每 turn 求值：system-prompt/src/index.ts:662
    })
  }
  for (const a of ctx.agents.list()) install(a)                    // tool-agent-team/src/index.ts:422
  ctx.on('agent/created', ({ agent }) => install(agent))           // tool-agent-team/src/index.ts:423
}
```

`nudge(agent)`：team lead/teammate 返回对应提示词，非 team 返回 `''`（§6）。骨架未包含 `agent/disposed` 释放与 `inject` 门禁细节，落地时补齐。

## 10. 实现阶段必须遵守的关键约束

1. section 名全局唯一，**每个 agent 只注册一次**；重复注册直接抛错（`packages/core/system-prompt/src/index.ts:53`）。用 `Set` 防 `agents.list()` 回放与 `agent/created` 双触发。
2. `text` 必须**同步**返回 `string`，不可返回 Promise（`:53`）。
3. 排序一律走 `getSectionOrder()` / `getContextOrder()`（`:494`、`:503`），禁止硬编码 `600`。
4. 非 team 一律返回 `''`，**绝不抛错**；空文本被安全剔除（`:293`、`:296`、`:336`）。
5. **不要缓存首轮角色**：`text` 每 turn 重算（`:662`），team 身份若中途变化必须即时体现；缓存会把 Lead 的 nudge 泄漏给已退队的 agent。
6. 需 per-agent 差异时，只在 `agent.ctx` 作用域注册（`:478` 的「调用者作用域」语义），不要试图从 `AssembleContext` 取 agent（`:42`）。
7. 零运行时依赖；纯 ESM，`"type": "module"`，不产出 `dist/`。
8. `engines.dsh` 写 `">=0.2.1-rc.1"`，让 alpha.4 宿主在加载期明确拒绝而不是运行期出错（`dsh-plugin-subagent-director/package.json:154`）。

## 11. 未解风险

1. **`AssembleContext` 无 `agent`** — 影响：角色只能靠闭包捕获的 `agent` + `agent.ctx` 作用域取得。**该 hook 现已验证**：`for (const agent of ctx.agents.list())`（`packages/experimental/tool-agent-team/src/index.ts:422`）+ `ctx.on('agent/created', ({ agent }) => …)`（`:423`），且 `agent.ctx` 可用（`:169`）。残余风险：upstream 在 `agent/created` 时刻用 `tryMembership()` 判定（`:419`），若成员资格此时尚未写入 roster，该 agent 永不被安装。本方案规避——section 无条件注册，team 判定放在 text 回调内（每 turn 重算，`packages/core/system-prompt/src/index.ts:662`）。
2. **per-session agent-preset 决定工具可见性**（`packages/bundle/web-app/cordis.patch.yml:560-570` 在 host 层禁用了 `tool-subagent*`）— 影响：`agent-team` 树级启用 ≠ 当前会话能看到 `spawn_teammate`。**不能**用「会话里没有 `spawn_teammate`」证明 team 关闭；反之也不保证注入的 nudge 一定有对应工具可调。解除方法：以 `ctx.agentTeams.tryMembership(agent)`（`agent-team/src/index.ts:219`）为唯一真判据，并在 nudge 文案中不假设具体工具名可用。
3. **profile 文件在 recon 期间被并发重写**（mtimes 变化）— 影响：`/home/csy/.dsh/profiles/web/*` 的当前内容可能已偏离宿主启动时加载的组合配置；`--dump-config` 看到的也可能不是内存态。解除方法：以 `dsh --profile web --dump-config` 为准并在同一秒内取 mtime 快照；装插件后重启宿主再核对。
4. **`dsh plugin --profile web add link:<repo>` 未验证** — 影响：文档给出的手写 `package.json` + `cordis.patch.yml` 是唯一确定可用路径。解除方法：`dsh plugin --help` 实测。
5. **宿主 argv 无 `--profile web`** — 影响：profile 绑定是推断（`Environment=DSH_HOME=/home/csy/.dsh` + 存在 `profiles/web`），非显式声明。解除方法：查 unit 文件全文与 `DSH_PROFILE` 类环境变量，或用 `--dump-config` 反推生效 profile 名。

## 12. 证据索引

**`packages/core/system-prompt/src/index.ts`**（rc.3 相对路径，下文同）：`:42`、`:53`、`:79`、`:84`、`:124`、`:124-140`、`:289`、`:290`、`:293`、`:296`、`:336`、`:383`、`:429`、`:446`、`:478`、`:494`、`:503`、`:513`、`:614`、`:662`

**`packages/experimental/tool-agent-team/src/index.ts`**：`:14`、`:161-166`、`:168`、`:169`、`:171`、`:173`、`:175`、`:176`、`:178`、`:180`、`:182`、`:411`、`:417`、`:419`、`:420`、`:422`、`:423`、`:424`

**`packages/experimental/agent-team/src/index.ts`**：`:116`、`:219`

**`packages/core/agent/src/index.ts`**：`:439`、`:516`、`:552`

**`packages/bundle/web-app/cordis.patch.yml`**：`:560-570`

**`/home/csy/.dsh/profiles/web/node_modules/dsh-hide-clock/package.json`**：`:6`、`:7`、`:14`、`:24`、`:25`、`:27-29`、`:47`

**`/home/csy/.dsh/profiles/web/node_modules/dsh-hide-clock/index.js`**：`:2`

**`/home/csy/.dsh/profiles/web/node_modules/dsh-hide-clock/cordis.patch.yml`**：`:1-3`

**`/home/csy/.dsh/profiles/web/node_modules/dsh-plugin-subagent-director/package.json`**：`:154`

**`/home/csy/.dsh/profiles/web/node_modules/dsh-plugin-subagent-director/lib/index.js`**：`:14`、`:15`

**`/home/csy/.dsh/profiles/web/package.json`**：`:4`、`:9`、`:12`、`:29`、`:32`、`:38`

**`/home/csy/.dsh/profiles/web/cordis.patch.yml`**：`:220-221`、`:222-227`

**运行时/系统**：`/proc/3170429/cwd`、`/home/csy/.config/systemd/user/deepseek-harness.service`（`WorkingDirectory`、`ExecStart`、`Environment=DSH_HOME=/home/csy/.dsh`）、`/tmp/dumpconfig-web-rc3.txt:1310-1325`（`agent-team` / `tool-agent-team` / `ui-agent-team` 未禁用）
