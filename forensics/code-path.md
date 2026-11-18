# T2 取证：DSH 中「teammate 完成任务后仍被复用」的代码路径

只读取证。宿主 checkout：`/home/csy/Code/installer/deepseek-harness-0.2.1-rc.5/`（下称 `PKG=`）。
当前仓库：`/home/csy/Code/Github/dsh-force-subagent`（下称 `REPO=`）。

检索口径：先用 vectr（`vectr_recall` #111/#119/#118/#146、`vectr_search`）。vectr 索引只覆盖 workspace 的 31 个文件（javascript/markdown/txt），**不含宿主 checkout**，故宿主侧按降级链改用 grep 工具 + `sed/awk` 定行取原文；`REPO=` 侧由 vectr 命中后再 grep 定位行号。所有引用均可用 `grep -n` 复核。

---

## 1. 成员生命周期：durable phase 与 runtime status 是两套状态

`PKG/experimental/agent-team/src/types.ts:45`

```ts
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'
```

durable phase 只有三值，**没有 inactive**；`active`/`failed` 是终态。

运行态视图 status 由 roster 现算：`PKG/experimental/agent-team/src/roster.ts:144-148`

```ts
        status: member.phase === 'failed'
          ? 'failed'
          : member.phase === 'provisioning'
            ? 'provisioning'
            : availability(live),
```

`roster.ts:474-477`

```ts
/** Turn availability is independent of whether the Agent is loaded. */
function availability(agent: Agent | undefined): 'running' | 'inactive' {
  return agent?.status === 'running' ? 'running' : 'inactive'
}
```

判定：`inactive` 只表示「当前没有 turn 在跑」，与成员是否可再用无关——它是 `availability()` 的返回值，不是 roster 的状态。`list_agents` 的工具描述把这点写明了：`PKG/experimental/tool-agent-team/src/index.ts:241`

```ts
      description: 'List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.',
```

状态机强制（append-only 投影）：`PKG/experimental/agent-team/src/projection.ts:258-267`

```ts
      if (prior === undefined) {
        if (member.phase !== 'provisioning') throw new Error(`teammate "${member.name}" must begin provisioning`)
      } else {
        if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) {
          throw new Error(`teammate "${member.id}" changed immutable identity fields`)
        }
        if (prior.phase !== 'provisioning' || member.phase === 'provisioning') {
          throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
        }
      }
      return { ...state, members: replaceAt(state.members, index, member) }
```

`projection.ts:241-245` 的 `replaceAt` 只有覆盖/追加两条分支，无删除分支：

```ts
function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const next = [...items]
  if (index < 0) next.push(item)
  else next[index] = item
  return next
}
```

`settleProvisioning` 也只会「已结算就不再改」：`roster.ts:451-457`（逐字，含 `/* v8 ignore next 3 */` 行）

```ts
    return this.journal.transact(root.id, async () => {
      const current = this.journal.state(root).members.find(member => member.id === terminal.id)
      /* v8 ignore next 3 -- the append-only provisioning event is committed by this operation before settlement. */
      if (current === undefined) {
        throw new TeamError(`provisioned teammate "${terminal.id}" disappeared`, 'TEAM_PROVISIONING_CONFLICT')
      }
      if (current.phase !== 'provisioning') return current.phase
```

持久层：成员整值快照只写进 Lead Session 的事件日志，事件类型闭合，无「成员移除」事件：`types.ts:229-232`

```ts
    /** Whole teammate lifecycle value, stored only in the Team Lead Session. */
    'team/member': { version: 2; teamId: TeamId; member: TeamMemberSnapshot }
    /** Whole shared-task value, stored only in the Team Lead Session. */
    'team/task': { version: 2; teamId: TeamId; task: TeamTaskSnapshot }
```

`PKG/experimental/agent-team/src/journal.ts:9` `type MutableTeamEventType = 'team/member' | 'team/task'`（任务有 tombstone `status: 'deleted'`，成员没有）。
官方措辞：`PKG/experimental/agent-team/README.md:205`「**Flat immutable roster** — only the Lead creates direct teammates; there is no nested Team, rename, deletion, or name reuse.」

结论：一旦某行 roster 进入 `active`，它在整个 Lead Session 生命周期内永久存在且永久可寻址。

---

## 2. 创建与同名处理：不存在「复用旧成员」的创建分支

`PKG/experimental/agent-team/src/roster.ts:243-259`（`spawnAdmitted`）

```ts
    const member: TeamMemberSnapshot = {
      id: childId,
      name,
      description,
      provider: requiredText(request.provider, 'provider', 200),
      context: request.context,
      phase: 'provisioning',
    }

    await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      if (state.members.some(member => member.name === name)) {
        throw new TeamError(`teammate name "${name}" was already used in this Team`, 'TEAM_MEMBER_NAME_TAKEN')
      }
      if (state.members.length >= this.maxMembers) {
        throw new TeamError(`Team member limit ${this.maxMembers} reached`, 'TEAM_MEMBER_LIMIT')
      }
```

判定：
- 同名 → 直接抛 `TEAM_MEMBER_NAME_TAKEN`（`roster.ts:254-255`），**不是**复用旧成员。
- 槽位统计含 `failed` 行（`state.members.length`，`roster.ts:257`），失败的成员永久占位。
- 新 childId 每次 `randomUUID()`（`roster.ts:242`）；`memberName` 的注释直言名字「never-reused」：`roster.ts:435`。
- 名字被他人复用另有一层投影级抛错：`projection.ts:254-257`。

即「创建」这条路上没有任何自动复用。复用只发生在**寻址 + 投递**那条路（第 3 节）。

---

## 3. 唤醒 / 复用入口：send_message 是唯一且显式的复用开关

### 3.1 寻址只看 durable phase，不看是否 live

`PKG/experimental/agent-team/src/roster.ts:42-53`

```ts
export function resolveActiveMember(
  root: Agent,
  state: TeamState,
  rawName: string,
): { id: SessionId; name: string } {
  const name = rawName.trim()
  if (name === 'lead') return { id: root.id, name }
  const member = state.members.find(candidate => candidate.name === name)
  if (member === undefined || member.phase !== 'active') {
    throw new TeamError(`active teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
  }
```

判定：判据是 `phase === 'active'`，与 live/running 无关。完成任务、Agent 已下线的成员依然 `active`，因此依然可被 `send_message` 点名。（`failed` 不可寻址。）

### 3.2 投递实现：Lead→teammate 走 host steer

`PKG/experimental/agent-team/src/index.ts:239-247`

```ts
    if (target.id === root.id) {
      const input = createUserMessage({ content, source })
      root.steer(input)
      messageId = input.id
    } else {
      messageId = await steerHostSubagentPrompt(this.ctx.subagents, root, target.id, content, source, request.signal)
    }
    this.activity.notify(membership.id)
```

`PKG/subagent/subagent/src/internal.ts:94-110` → `manager.steerPrompt`（`manager.ts:604-612`）→ `deliverToChild`。

### 3.3 coldResume：不在内存的成员被从持久化里拉回来重跑

`PKG/subagent/subagent/src/manager.ts:1253-1256`

```ts
    while (true) {
      const live = await this.locks.run(childId, async () => {
        const activation = this.resident.get(childId)
        if (activation === undefined) return this.coldResume(parent, childId, content, options)
```

`manager.ts:1326-1334` + `1349-1355`

```ts
   * Cold-resume a persisted child and submit the waiting turn. The descriptor
   * supplies every reconstruction input; no subagent provider is dispatched.
   */
  private async coldResume(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<MessageId> {
...
    const descriptor = foldSubagentDescriptor(ownEvents)
    if (descriptor === undefined || descriptor.mode !== 'continuable') {
      throw new SubagentError(
        `subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`,
        'NOT_RESUMABLE',
      )
```

`manager.ts:1363-1365` 起 `materialize({ kind: 'local', childId, provider: descriptor.provider, parent, ... })` 用同一 `childId` 重建 live Agent —— 同一名成员被再次激活。

官方文档同样表述：
- `PKG/subagent/subagent/src/index.ts:298-300`「A running target admits it at the nearest step boundary; an idle target starts a turn, and an absent direct child cold-resumes from persistence.」
- `PKG/experimental/agent-team/README.md:70`「Steer gives a running target the message at its nearest step boundary and starts or cold-resumes an inactive target.」
- `README.md:132`「Teammate delivery uses the continuation owner's host-only Steer path, which … authoriz[es] the Lead-to-child edge and cold-resum[es] inactive targets.」
- `README.md:192`「Peer messages append after the target's reusable history prefix. Cold resume reuses the persisted conversation before appending the new message.」

### 3.4 成员 turn 结束后并不离开内存：resident 只在 rollback / dispose 时移除

`manager.ts:943` `this.resident.set(childId, activation)`；`manager.ts:950-954`

```ts
      if (activation.kind === 'local') {
        observeLocalFailure(activation, wakeSettlement)
        activation.handle.agent.ctx.on('agent/inbox/inserted', wakeSettlement)
        activation.handle.agent.ctx.on('agent/inbox/claimed', wakeSettlement)
        activation.handle.agent.ctx.on('agent/inbox/discarded', wakeSettlement)
      }
```

`resident.delete` 只出现在 `rollbackUnpublished`（`manager.ts:987`）与释放/teardown 路径（`manager.ts:1175`）。成员一轮跑完只走 `announce`/`watchLocalSettlement`（`manager.ts:970-979`），没有任何「完成后释放」的分支。
`manager.ts:248` 注释：「Join progressing child work, leaving idle parked inboxes resident.」

判定：成员交付结果后仍是 resident 的 live Agent（status 由 `agent.status` 变 idle → roster 显示 `inactive`），Lead 再发一条消息即可直接 steer 进新 turn——连 coldResume 都不需要。

### 3.5 interrupt 不是移除，只是打断当前 turn

`roster.ts:187-197`

```ts
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' } {
    const membership = this.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can interrupt teammates', 'TEAM_LEAD_REQUIRED')
    const state = this.journal.state(membership.root)
    const target = resolveActiveMember(membership.root, state, targetName)
    if (target.id === membership.root.id) throw new TeamError('the Team Lead cannot interrupt itself', 'TEAM_INVALID_TARGET')
    const live = this.ctx.agents.get(target.id)
    if (live === undefined) return { previousStatus: 'inactive' }
    const previousStatus = availability(live)
    this.ctx.subagents.interrupt(target.id, { kind: 'ancestor', agent: caller })
```

`PKG/subagent/subagent/src/index.ts:344-353`

```
   * Interrupt one live child's current execution under a human parent
   * address or an exact live ancestor Agent. Fire-and-return: the cancel
   * signal is issued before this returns, but the target may keep running
   * until it observes the signal. Unclaimed pending inbox work, the Activation,
   * and published descendants are preserved; claimed work is not requeued.
   * Once the interrupted Agent is idle, a waking send resumes the parked FIFO
   * queue.
```

判定：`interrupt_agent` 保留 Activation 与 pending inbox；被中断后「一条唤醒消息会接着跑」。roster 行的 durable `phase` 完全不变。

### 3.6 提示词层面主动引导 Lead 复用 inactive 成员

`PKG/experimental/tool-agent-team/src/index.ts:34-41`（`teamPolicy`，Lead 与成员共用）

```
Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, …
send_message steers a running target at its nearest step boundary and starts or resumes an inactive target.
inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents.
…
Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive.
```

`tool-agent-team/src/index.ts:45`

```ts
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.'
```

`tool-agent-team/src/index.ts:222-223`

```ts
      name: 'send_message',
      description: 'Send one message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.',
```

判定：宿主的工具描述 + systemPrompt 明确告诉模型「inactive 就用 send_message 唤醒」。这是模型侧被推向复用的直接动因。

### 3.7 wait_agent 只观察，不唤醒；但成员状态变化会唤醒 Lead

`tool-agent-team/src/index.ts:250-251`（描述）「This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning.」
`PKG/experimental/agent-team/src/index.ts:199-202`

```ts
  async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    const membership = this.roster.membership(caller)
    return await this.activity.wait(membership.id, timeoutMs, signal)
  }
```

`PKG/experimental/agent-team/src/index.ts:89` 与 `93-97`

```ts
    this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) })
...
    ctx.on('agent/created', ({ agent }) => { this.scheduleRecovery(agent) })
    ctx.on('agent/status', ({ agent }) => {
      const membership = this.roster.tryMembership(agent)
      if (membership !== undefined) this.activity.notify(membership.id)
    })
```

`PKG/experimental/agent-team/src/activity.ts:72-76`

```ts
  notify(id: TeamId): void {
    const waiters = this.waiters.get(id)
    if (waiters === undefined) return
    this.waiters.delete(id)
    for (const waiter of waiters) waiter.resolve()
  }
```

判定：成员 turn 结束触发 `agent/status` → 唤醒 Lead 的 `wait_agent` → Lead 被 3.6 的提示词引导去 `send_message` 唤醒该成员。这是一条「完成事件 → Lead 复用」的反馈回路，但触发方仍是 Lead 的工具调用，不是宿主自动派活。

### 3.8 REPO 侧：插件只加提示词与工具门禁，没有任何复用或清理逻辑

- `REPO/index.js:227` `LEAD_NUDGE`、`:230` `FLAT_LEAD_APPENDIX`、`:233` `MEMBER_NUDGE`、`:236` `MEMBER_NUDGE_FLAT` 全是文本注入。`index.js:230` 里对复用的处置是纯要求：

```
已完成 → 立即 interrupt_agent 中断该成员，并用 team_task_update 关闭对应任务，此后永不再向该成员 send_message、不得复用该成员；未完成 → 继续给该成员派活。注意：宿主没有删除 Team 成员的 API（… roster 行 append-only，active / failed 是硬终态），软踢出只能做到「interrupt_agent 中断其当前 turn + 不再 send_message 唤醒」
```

- 门禁只有三条 deny，没有一条涉及 send_message 或成员复用：`REPO/index.js:507`（相邻两次 `wait_agent`）、`:515-519`（flat 模式封 `DELEGATION_TOOLS`，见 `:315`）、`:522-525`（nested 模式白名单外 deny）、`:572-576`（Lead 未 `team_task_create` 就取证）。`send_message` 在 `ALLOWED_TOOLS` 内（`REPO/index.js:295`），永不 deny。
- `memberIds()`（`REPO/index.js:197-217`）只读 `team/member` 事件取 childId，用于模型路由；无任何写事件、无 roster 清理能力。
- `REPO/client.js` 对 `send_message|interrupt_agent|reopen|复用|inactive` 零命中（`grep -n` 空结果），它只是设置页。

判定：插件无法强制「不得复用」，它只能靠提示词请求；宿主没有可拦截的「完成」信号可给它拦。

---

## 4. resume / 重启恢复：roster 从 Lead Session 日志原样回来

- 成员身份映射靠持久父子边 + roster 行：`roster.ts:89-99`

```ts
  tryMembership(agent: Agent): TeamMembership | undefined {
    if (this.ctx.agents.get(agent.id) !== agent) return undefined
    try {
      const parentId = agent.session.header.parentSession
      if (parentId !== undefined) {
        const root = this.ctx.agents.get(parentId)
        if (root !== undefined) {
          const member = this.journal.state(root).members.find(candidate => candidate.id === agent.id)
          if (member?.phase === 'active' || member?.phase === 'provisioning') {
            return { root, id: TeamId(root.id), role: 'teammate', name: member.name }
```

- 重启钩子：`agent-team/src/index.ts:93`（`agent/created` → `scheduleRecovery`）与 `index.ts:108`（构造时 `for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)`）→ `index.ts:251-259` → `roster.ts:175-179`

```ts
  async recoverFor(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const membership = this.tryMembership(agent)
    if (membership?.role === 'lead') await this.reconcileProvisioning(membership.root, signal)
  }
```

- `reconcileProvisioning` 只处理残留 `provisioning` 行，按持久化证据结算成 `active` 或 `failed`：`roster.ts:376`（`filter(member => member.phase === 'provisioning')`）、`389-396`、`404-414`（`appendAndFlush(root, 'team/member', { … member: settled })`）。
- 已经是 `active` 的行恢复后立刻可寻址（`resolveActiveMember`），live Agent 不在则显示 `inactive`，第一条消息把它 coldResume 回来（第 3.3 节）。
- `README.md:62`「A member that is not loaded receives its messages when it wakes.」

判定：resume 不产生「新的复用」，它只是把同一批永久 roster 行原样恢复；`interrupt` 与重启都不会让成员从 roster 消失。

---

## 5. 结论

**Q：宿主有没有「完成后自动复用同一成员」的行为？**
**没有。** 没有任何代码在「成员一轮结束」或「任务 complete」之后自动给它派新活：
- 完成后的处理只有 settle：`manager.ts:970-979`（`announce` / `watchLocalSettlement`），无 re-dispatch 分支。
- 任务 `complete` 只改状态位：`PKG/experimental/agent-team/src/task-board.ts:162-166`

```ts
        case 'complete':
          authorizeOwner()
          if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
          next = { ...current, status: 'completed' }
          break
```

- 宿主侧唯二的自动钩子是 `scheduleRecovery`（只结算 `provisioning` 行，`roster.ts:376`）与 `activity.notify`（只唤醒 wait_agent 等待者，`activity.ts:72-76`）。派活必须由某个 Agent 显式调 `send_message` / `spawn_teammate`。

**用户看到的「复用」来自这些真实路径（按可能性排序）：**

1. **Lead 显式 `send_message` + coldResume（主路径）。** 成员结果交回后它仍在 resident 表里（`manager.ts:943`，删除只在 `:987`/`:1175`）或被 coldResume（`manager.ts:1256`、`1329-1355`、`1363-1365`）；寻址只看 `phase === 'active'`（`roster.ts:50`）。宿主提示词还明确指示「inactive 就用 send_message 唤醒」（`tool-agent-team/src/index.ts:41`、`:45`、`:223`）。所以 Lead 在下一轮把新活派给同一个名字，是被工具语义和 systemPrompt 共同许可、且被 `agent/status` 唤醒事件（`agent-team/src/index.ts:94-97`）促成的。
2. **roster 行永久保留 + 无删除 API（结构性原因）。** `active` 是硬终态、无删除分支（`projection.ts:241-245`、`264-266`；`README.md:205`）；`interrupt_agent` 不清 inbox 也不动 phase（`roster.ts:187-197`；`subagent/src/index.ts:348-351`「Unclaimed pending inbox work, the Activation, and published descendants are preserved… a waking send resumes the parked FIFO queue」）。因此 `list_agents` 永远列出该成员，模型永远能点名它。
3. **看板 owner 字段不清造成的视觉印象（不是复用机制）。** `complete` 不调 `withoutOwner`（`task-board.ts:165` vs `:251-254`），completed 任务仍带 `ownerId`/`ownerName`，`team_task_list` 的 owner 过滤仍能把它归到该成员名下。**任务 reopen 后原 owner 继续**这条假设被证据否定：`reopen` 明确清 owner（`task-board.ts:167-171`）。
4. **resume 恢复 roster（放大器，不是新机制）。** 第 4 节：同一批 `active` 行原样回来，重启后第一条消息即 coldResume 原成员。
5. **REPO 插件无 enforce。** `index.js:452-577` 的三条 deny 均与 `send_message`/复用无关，`FLAT_LEAD_APPENDIX`（`index.js:230`）的「不得复用该成员」只是文本要求。

**SPECULATION（无代码证据，只有推理）：**
- 具体会话里 Lead 之所以复用旧成员，是模型遵循了 `teamPolicy` 的「use send_message first when the required member is inactive」而不是任何宿主强制——这是从提示词文本与工具描述推出的动因判断，未观测模型内部决策。
- force-subagent 的「完成即 interrupt 并永不再 send_message」在实践中失效，最可能的原因是它没有对应的 `tools/pre-execute` deny（`index.js:452-577` 缺这条分支），而不是宿主另有绕过路径。要在 flat 模式真正阻止复用，可拦截的落点只有 `send_message` 对 `phase === 'active'` 且已被判定完成的目标——宿主提供了这个可拦截点（`tool-agent-team` 的工具注册 `index.ts:222-237` + `REPO` 已有的 `tools/pre-execute` 监听），但两者目前都没这么做。此句为设计推断，属 SPECULATION。
