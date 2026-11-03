# 消息级提醒注入：可行（harness 0.2.1-rc.3）

结论：**可行**。harness 有官方消息级写入点 `agent/pre-step`（waterfall，可替换本轮进入模型的 messages），
可在「leader 收到新用户 prompt」与「teammate 收到 lead 消息」时把提醒追加到那一条消息上，不必再走 systemPrompt.scoped。

## 1. 推荐 API

| 用途 | 位置 | 说明 |
| :-- | :-- | :-- |
| 钩子签名 | `packages/core/agent/src/runtime-types.ts:320` | `'agent/pre-step'(payload{agent,messages,turn,step,signal}, next)` |
| 返回值类型 | `packages/core/agent/src/runtime-types.ts:112-119` | `PreStepDecision = {kind:'reject'} \| {kind:'enter', messages: UserMessage[]}` |
| 派发点 | `packages/core/agent-loop/src/agent.ts:267-288` | 先 `inbox.claim()` 取出待进入消息，再 waterfall；`await next()` 拿默认 decision |
| 消费点 | `packages/core/agent-loop/src/agent.ts:290` → `:429-436` | `decision.messages` 首次尝试时逐条 `session.append('user/message', …)` 并进入请求 |
| 官方同款前例 | `packages/context/agent-instructions/src/index.ts:334-359` | `next()` 后 `decision.messages.toSpliced(...)` 改注入内容 |
| 消息 source 表 | `packages/llm/llm/src/message.ts:105-115` | `MessageSourceMap`，merge-extensible |

系统提示词路径（`docs/agent-team-api.md:108,118,218`）只覆盖 `PromptAssembly`/`AssembleContext`，没有 messages 字段；消息级能力只存在于 pre-step（源码事实，非文档契约）。

## 2. 注入点与角色区分

在 pre-step 里调用 `await next()`，得到默认 decision（含本轮 claimed 消息 + 运行时 context 消息）。找到 claimed 消息中最后一条，
按 `source.kind` 判断来源，然后返回 `{...decision, messages: toSpliced(at, 1, patched)}`：

| 场景 | `role` | `source.kind` | 字段 |
| :-- | :-- | :-- | :-- |
| leader 收到真实用户 prompt | `user` | `user` | 可能带 `rpcId`/`clientTimeZone` |
| teammate 收到 lead 消息（send_message） | `user` | **`agent-message`** | `form:'relay'`, `senderSessionId`（`packages/subagent/subagent/src/continuation-messages.ts:14-22,41-47,61-70`） |
| 历史 Team mailbox 投递（本部署未见） | `user` | `team-message` | `teamId`,`messageId`,`senderId`,`senderName`（`packages/experimental/agent-team/src/types.ts:138-146`） |
| 子代理结算/时间/技能等 | `user` | `subagent-settled`/`time-context`/`skill-invocation` | 不是目标，跳过 |

`role` 全是 `user`，**只能用 `source.kind` 区分**。判别写成 `kind === 'user' || kind === 'agent-message'`，`team-message` 作为潜在分支保留（本部署实证走 `agent-message`，正文前缀 `Team message from lead:`）。

## 3. 幂等与缓存

- **只追加一次**：claimed 消息在一个 step 只被 admit 一次（`agent.ts:429` 的 `if (firstAttempt)`）；求值粒度是「每次 assembly」，重试复用同一 assembly、不重跑 pre-step，不会重复 append。
- **持久化**：追加后的消息随 `session.append('user/message', message)` 落进历史，UI 与后续回放都含提醒文本 → 后续轮次模型必见，无需每轮重算。
- **防重入**：文本结尾写 MARK（如 `<!-- force-subagent -->`），命中即跳过；覆盖 abort/重驱动导致的重复 claim。
- **缓存**：追加只在消息内容尾部，该消息之前前缀不变，且首次进入时其后无 token → prefix/KV 缓存基本不失效。
- **历史改写**：durable log 原文不变；模型可见 surface 支持 `{op:'replace', startSeq, endSeq}`（`packages/core/session/src/types.ts:465`），守卫只限制 node 0（system prompt，`packages/core/session/src/surface.ts:504-510`），其余段可重写。`inbox.replace` 另限 pending 消息。但本方案不需要它。

## 4. 最小草图（13 行）

```ts
const MARK = '<!-- force-subagent -->'
ctx.on('agent/pre-step', async ({ messages }, next): Promise<PreStepDecision> => {
  const decision = await next()
  if (decision.kind === 'reject' || messages.length === 0) return decision
  const at = decision.messages.findLastIndex(m => messages.includes(m))
  if (at < 0) return decision
  const target = decision.messages[at]
  if (target.role !== 'user') return decision
  if (target.source.kind !== 'user' && target.source.kind !== 'agent-message') return decision
  if (target.content.some(b => b.type === 'text' && b.text.includes(MARK))) return decision
  const patched = { ...target, content: [...target.content, { type: 'text' as const, text: `\n\n${MARK}\n${reminder}` }] }
  return { ...decision, messages: decision.messages.toSpliced(at, 1, patched) }
})
```

需要 ctx：仅 `ctx.on('agent/pre-step', …)`；无需 `systemPrompt`/`inbox` 服务（插入新消息方案才需要 `agent.inbox.remove`）。

## 5. 风险与不可行项

1. **原文被污染**：追加内容随消息持久化，UI/会话历史出现提醒文本；排查问题时模型看到的与用户输入不一致（知情即可）。替代是插入独立 context 消息（`agent-instructions` 前例），但不是"追加到那一条消息上"。
2. **边界**：`step === 1 && decision.messages.length === 0` 时不要造出独立请求，直接返回原 decision（照 `agent-instructions:1412`）。
3. **token 成本**：每条目标消息 +100–255 字，长会话累积；建议只注入首条并控制长度。
4. **不可行**：`developer/message` 插件不可写（唯一写入点 `packages/core/agent-loop/src/agent.ts:660`，`kind:'tool-registry'`）；无"改写已落库 user 消息"的 API。
5. **次优备选**：`agent.steer(createUserMessage({…, source:{kind:'force-subagent'}}))`（`experimental/hooks-claude-code/src/index.ts` 有前例）→ 变成额外一条 user 消息，非追加。
6. **模型不可区分**：提醒与用户原文混在同一条消息内，模型无法分辨来源；如需可追溯，用 MARK 包裹并在 system 侧说明 MARK 语义。

## 6. 替代设计（未采用）

- `systemPrompt.context()`（`docs/subsystems/system-prompt.md:76-90,153`，user-role durable snapshot）**不采用**：它要求把提醒并入 system 侧快照，受 compaction/变化时机约束，属重做语义；当前 `agent/pre-step` 尾部追加已通过 3 轮对抗审查 + 16 测试 + 变异验证，前缀缓存影响仅在消息末尾、无失效证据，切换成本大于收益。
- 用户目标（每条 Lead 消息后附提醒）已由 `agent/pre-step` 满足，无需第二套机制。
- 本地文档 `docs/prompt-plugin-api.md:3/121/172/218` 与 `docs/agent-team-api.md:285` 称「`AssembleContext` 不含 `agent`」**有误**，以官方 `packages/core/agent/src/runtime-types.ts:18-22`（`agent?: Agent`）为准。
