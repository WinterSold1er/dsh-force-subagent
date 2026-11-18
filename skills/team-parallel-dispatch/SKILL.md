---
name: team-parallel-dispatch
description: Use when organizing or running an agent team with `agent-team` (via batched `subagent` dispatch, `send_message`, `wait_agent`), or when dispatching multiple teammates for a task. Ensures team members work in parallel via DAG task graphs, distinct write_scopes, batch dispatch, and board-driven task assignment instead of single-threaded serial execution.
---

# Team Parallel Dispatch (团队高并发调度)

## Overview
在 DSH 的 `agent-team` 协作中，`subagent` 派发和 `send_message` 本身是非阻塞的异步操作。本技能指导 Team Lead 克服大模型固有的单线程串行思考倾向，通过任务图（DAG）解耦、独立写入边界（`write_scopes`）、批量并发派发和事件驱动等待，最大化多成员并行工作效率。

## When to Use This Skill
- 当使用 `agent-team` 规划并执行涉及多角色、多模块或多步骤的复杂任务时。
- 当用户要求“团队协作”、“组织团队”、“让多个 agent 一起做”或“提高团队执行效率”时。

## Core Concurrency Rules (核心并发原则)

### 1. 任务图解耦与看板驱动（Pre-plan Task DAG）
- **不要逐个口头指派**：在开始执行前，先用 `todo_write` 建立完整的子任务看板（DAG 任务粒度）。
- **最小化依赖（`blocked_by`）**：
  - 只有存在真实上下文依赖或产出先后顺序的任务才设置 `blocked_by: [taskId]`。
  - 同阶段可并行的任务，必须保持 `blocked_by: []`，使其天然处于 ready 状态。
- **划分互斥写入范围（`write_scopes`）**：
  - 为每个并发任务显式配置独立的工作目录/文件前缀（如 `["packages/core/src/*"]`, `["packages/api/src/*"]`）。
  - 严禁让两个并行 Worker 修改同一个文件，从根本上避免文件冲突。

### 2. 批量扇出派发（Batch Fan-Out Spawning）
- **严禁串行等待循环**：严禁采用 `subagent(A) -> wait -> subagent(B) -> wait` 的低效模式。
- **单轮并发拉起**：
  - Lead 在同一轮中并行发起全部 `subagent` 调用，拉起所有初始并行 Worker（例如 `backend-dev`, `frontend-dev`, `tester`，以及命名为 `name: "reviewer"` 的 Reviewer——插件按名路由到「审查代码模型」）。
  - 每个 Worker 的 prompt 必须自包含：包含其角色定位、工作目录、互斥写入边界（`write_scopes`）、执行哪个看板任务与验收标准。
- **自驱完工模式（保留 Pull-based 自驱精神）**：
  - 指示 Worker 自驱：执行被指派任务 -> 真实校验 -> `send_message` 回传结果给 Lead（Lead 更新看板状态），做完即停。
  - **干完不得空转轮询**：Worker 完成手头任务后即进入 `inactive`，严禁反复扫看板或反复 `wait_agent` 空转；有新任务由 Lead 用 `send_message` 唤醒。

### 3. 统一监听与响应（Unified Wait & Reactive Steering）
- 批量派发完成后，Lead 调用 `wait_agent(timeout_ms: 30000)` 挂起等待。
- 当任意成员状态变更（如完成一轮变为 `inactive` 或任务状态更新），Lead 被唤醒：
  1. 调用 `list_agents` 查看成员状态，并核对 `todo_write` 看板检查当前进度；
  2. 若有阻塞任务的依赖已解除，通知空闲成员接力；
  3. 若所有任务均已完成，转入收尾与集成验证；若仍有在跑成员，继续调用 `wait_agent`。

### 4. 成员分工优先，严禁 Leader 大包大揽（Delegate to Members, Avoid Leader Doing Work）
- **Leader 定位为规划、编排与协调**：Leader 的核心职责是需求拆解、任务图建立（DAG）、成员拉起、跨成员推进与最终质量把关，坚决避免 Leader 亲自编写业务代码、移植逻辑或手写大量测试。
- **具体工作全力下放给队员**：代码实现、协议移植、构建调试、E2E 验证脚本编写、对比测试等所有执行工作，必须通过看板任务分配给专职队友（如架构/开发、测试/验证、审查/对抗等）。
- **杜绝单干倾向**：只要使用了 `agent-team`，就必须把开发与验证任务最大化交由团队成员并行承担，别老让 Leader 自己动手做。

### 5. 尽力并行与空转纪律（Best-Effort Parallelism & Idle Discipline）
- **并行是“尽量”而非“必须”**：并行只是缩短关键路径的手段，不是硬指标。任务存在真实依赖、或拆分成本高于收益时，照常串行执行，不要为凑并发硬拆任务。
- **无任务成员不得轮询**：没有就绪任务的成员保持 `inactive` 即可，不需要持续轮询；由 Lead 在依赖解除后用 `send_message` 唤醒。
- **模型与思考强度跟随插件路由**：模型分配由 `dsh-force-subagent` 按工作区/全局配置统一路由（成员模型 / 子代理模型 / 审查代码模型）；Reviewer 成员（命名 `reviewer`）路由到「审查代码模型」，未单独配置时回退成员/子代理路由。
  - 派发调用一般不手动传 `provider` / `model` / `reasoning_effort`（`subagent_fork` 不接受这些参数；本地模型不支持思考强度时禁止传 `reasoning_effort`）。
  - Leader 与 Reviewer 角色思考强度高于其余成员的期望，通过模型/思考强度配置实现而非派发 prompt；派发 prompt 不得要求成员“拉满思考强度”。
