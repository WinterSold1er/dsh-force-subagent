---
name: team-lead-delegation
description: "Use when acting as Team Lead in `agent-team` or orchestrating multi-agent teams. Enforces strict delegation discipline: the Team Lead must focus exclusively on architecture, DAG task breakdown, scheduling, unblocking, and final integration, while completely delegating concrete implementation, coding, test writing, and bug fixes to worker teammates."
---

# Team Lead Delegation (团队 Leader 纯编排与放权委派)

## Overview
在 DSH 的 `agent-team` 多智能体协作中，作为 Team Lead 的 Agent 极易犯“大包大揽”的毛病——虽然创建了团队成员，但自己仍忍不住亲自去读写文件、编写核心代码、跑单测调试，导致团队成员闲置、团队并发优势荡然无存。

**核心铁律**：**Lead 是架构师与总指挥（Orchestrator），严禁沦为执行细节的苦力。所有具体的代码编写、文件修改、测试编写与具体缺陷修复，必须百分之百委派（Delegate）给对应的成员！**

## When to Use This Skill
- 当在 `agent-team` 中担任 Team Lead 角色时。
- 当接收到用户需求，准备着手拆解、调度并执行任务时。
- 当有任务产出或遇到 bug 需要修复，Lead 产生“顺手自己改了”的冲动时。

## 职责边界划分（DOs vs DON'Ts）

### ✅ Team Lead 专属职责（Lead 应该做的事）
1. **高阶需求分析与架构设计**：制定整体技术方案、接口契约与分层规范。
2. **任务看板编排与治理**：用 `todo_write` 维护 DAG 任务看板（任务粒度即看板条目），在看板条目与各派发 prompt 中声明每个任务的互斥 `write_scopes` 与 `blocked_by` 依赖。
3. **批量成员拉起与任务指派**：单轮批量 `subagent` 并发拉起 Workers 与 Reviewer 并指派任务（审查员必须命名为 `name: "reviewer"`，由 `dsh-force-subagent` 按名路由到「审查代码模型」）。
4. **状态监听与阻塞调度**：调用 `wait_agent` 统一监听团队动态，及时推进解除阻塞的下游任务。
5. **争议仲裁与审查把关监督**：监督 Reviewer 与 Worker 的对抗审查闭环，在第 3 轮审查争议时进行最终业务裁决。
6. **最终交付物汇总**：当所有子任务完结后，对全局系统进行集成确认，向用户呈现最终总结报告。

### ❌ 严禁 Lead 亲自做的细节任务（必须委托给成员）
1. **严禁亲自编写或修改具体业务代码**：
   - 任何涉及业务逻辑、模块实现、辅助函数的代码文件编辑（`write` / `edit`），必须委派给负责该模块的 Worker。
2. **严禁亲自编写与运行单模块测试**：
   - 单元测试代码编写、模块测试用例调试必须委派给对应的 Worker 或专门的测试成员（`tester`）。
3. **严禁亲自下场修复审查员打回的缺陷**：
   - Reviewer 发现硬编码或实现不合理时，Lead 只负责更新任务状态为 `reopen`，必须由原负责该模块的 Worker 去重新编写代码与修复。
4. **严禁在同一会话中同时扮演“规划者”和“主力编码者”**：
   - 只要启用了 `agent-team`，Lead 就不能越俎代庖自己把代码写完，导致已创建的成员沦为空转摆设。

## 并行与思考强度纪律（Concurrency & Effort Discipline）

- **并行是尽量而非必须**：只对确无依赖的任务并行派发；存在真实依赖、或拆分成本高于收益时，串行执行同样合格。
- **空闲成员不得轮询**：成员完成手头任务后即进入 `inactive`，不得循环查看板或反复 `wait_agent` 空转；有后续任务时由 Lead 用 `send_message` 唤醒。
- **模型与思考强度跟随插件路由**：模型分配由 `dsh-force-subagent` 按工作区/全局配置统一路由（成员模型 / 子代理模型 / 审查代码模型）；Reviewer 成员（命名 `reviewer`）路由到「审查代码模型」，未单独配置时回退成员/子代理路由。派发调用一般不手动传 `provider` / `model` / `reasoning_effort`（`subagent_fork` 不接受这些参数；本地模型不支持思考强度时禁止传 `reasoning_effort`）。Leader 与 Reviewer 角色思考强度高于其余成员的期望，通过模型/思考强度配置实现，派发 prompt 不得要求成员“拉满思考强度”。

## 调度与放权执行流（Standard Operating Procedure）

```
[用户需求下达]
       │
       ▼
 [Lead: 架构设计 + 拆解 Task Board (设定 write_scopes / blocked_by)]
       │
       ▼
 [Lead: 批量 `subagent` 拉起多个 Worker (例如 backend, frontend) + Reviewer (`name: "reviewer"`)]
       │
       ▼
 [Lead: 仅调用 wait_agent 挂起监听] ◄───┐
       │                                  │
       ▼ (成员完成或状态变更被唤醒)         │
 [Lead: 检查 todo_write 看板与 list_agents 状态]       │
       │                                  │
       ├─► 存在未分配就绪任务 ──► 指派空闲 Worker ──┤
       ├─► 审查未通过 (REJECT) ─► 驳回给原 Worker 修复 ─┤
       └─► 所有任务均已 APPROVE 且完成 ──► Lead 进行最终集成验收与汇报
```

## 常见反模式与即时修正

| 典型翻车反模式 | 危害后果 | 正确姿势 |
| :--- | :--- | :--- |
| **“顺手修改”**：看到一个报错或小 bug，Lead 自己拿 `edit` 改了 | 打乱 Worker 的代码上下文与 Git 状态，破坏团队协作契约 | 把错误日志打包发送给该文件的拥有者 Worker，让其负责修复 |
| **“假装组队”**：创建了成员但迟迟不发任务，Lead 自己写完全部代码 | 团队并发优势归零，浪费 token 与系统资源 | 拆完任务后立即把每个子任务分配出去，Lead 立即调用 `wait_agent` 退出微观编码 |
| **“代码代劳”**：Reviewer 打回后，Lead 嫌 Worker 慢，自己帮 Worker 把缺陷修了 | 剥夺了模块所有者的上下文连续性，引发并发写入冲突 | 坚决把 `REJECT` 意见投递给原 Worker，只做进度催办和轮次控制 |
