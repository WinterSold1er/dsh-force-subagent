---
name: team-recursive-orchestration
description: "Use whenever `agent-team` is used, in any role (Lead, Worker, Reviewer, tester). Requires each member to delegate concrete execution to lower-level subagents and stay orchestrator-only: split, dispatch, wait, merge."
---

# Team Recursive Orchestration (逐级编排)

## Overview
Lead 只编排不够。Worker 自己下场写代码，一样串行阻塞。本技能把 `team-lead-delegation` 向下递归一层：每个成员也是小 Lead，只做编排。

**铁律**：**拿到任务先拆分，能派就派，自己尽量不写代码。**

## When to Use
- 作为 `agent-team` 任意成员收到任务时。
- 任务超过 1 个文件改动、或超 2 步时。

## Rules
1. **默认派发**：具体 `write` / `edit` / `bash` / 测试运行，全部交 `subagent` / `subagent_fork` / `workflow` 做。自己只保留拆分、组装、校验。
2. **深度上限 2 层**：Lead → 成员 → subagent 到此为止。subagent 直接执行，禁止再派发下级 subagent，避免爆炸。确需再拆，报 Lead 裁决。
3. **并发一起发**：无依赖子任务单轮批量起 `subagent`，然后等结果，不要一个个串行等。
4. **作用域互斥**：子任务划分 disjoint 写范围，prompt 写明文件边界与验收标准。
5. **例外直做**：单文件单行改、只读校验、Lead 点名直做（含 rc.2 flat 模式软门禁提醒下允许的原子写集），三者之一才允许亲手做，并在结果注明 `DIRECT: <原因>`。
6. **模型分配**：模型分配由 `dsh-force-subagent` 插件按工作区/全局配置统一路由——Lead 派成员走「成员模型」，成员派发的二级 `subagent` 走「子代理模型」，Reviewer 成员（`name: "reviewer"`，多个可用 `reviewer-1`、`code-reviewer` 等）走「审查代码模型」，未单独指定「审查代码模型」时回退成员/子代理路由；不许改用配置外的模型，派发调用一般不手动传 `provider` / `model` / `reasoning_effort`（`subagent_fork` 不接受这些参数）。**本地模型不支持思考强度时，禁止传 `reasoning_effort`。**

## SOP
```
[成员收到任务]
  ▼
[拆 ≤3 个子任务, 定边界与验收]
  ▼
[批量 subagent 派发] → [等回结果]
  ▼
[合并 + 跑关键校验] → [交 Lead / Reviewer]
```

## 反模式
| 反模式 | 后果 | 正姿 |
| :--- | :--- | :--- |
| 成员亲手写完全部代码 | 成员级串行，和 Lead 大包大揽同错 | 先拆再派，自己只合并 |
| 逐个起 subagent 等一个 | 延迟叠加 | 批量起，一起等 |
| 无限再套娃 | 上下文爆炸 | 2 层封顶，超限上报 |
| 手动指定插件路由外的模型派 subagent | 违反 dsh-force-subagent 模型路由约定 | 跟随插件的成员模型 / 子代理模型 / 审查代码模型路由，不手动传 `provider` / `model` / `reasoning_effort` |
