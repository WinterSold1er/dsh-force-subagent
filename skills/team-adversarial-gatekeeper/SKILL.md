---
name: team-adversarial-gatekeeper
description: Use when running an agent team with `agent-team` to review and verify implementations, or when ensuring implementation soundness. Establishes a dedicated adversarial reviewer (`reviewer`) who strictly verifies implementation soundness and rejects superficial/half-assed work — such as hardcoding, test overfitting, swallowed errors, hollow tests, and architectural bypasses — requiring iterative fixes until genuine robustness is proven.
---

# Team Adversarial Gatekeeper (团队实现合理性把关审查员)

## Overview
在 `agent-team` 软件工程中，开发类 Agent 往往存在走捷径、硬编码以迎合测试、吞噬异常或敷衍完成的倾向。本技能指导团队设立专职把关的审查员（`reviewer`），专职审查**实现的合理性、真实性与健壮性**。

**关键定位**：审查员绝不是在缩进、排版、主观命名等无关痛痒的细节上挑刺，而是严密排查“实现是否合理、是否存在糊弄与伪造”，通过“挑出实质毛病 - 坚决打回修改”的对抗闭环确保交付质量。

## When to Use This Skill
- 当使用 `agent-team` 进行功能开发、代码重构、缺陷修复或方案实现时。
- 当团队成员提交产出准备标记任务完成（`complete`），需要对实现进行严格把关时。
- 当需要杜绝大模型“硬编码作弊”、“敷衍糊弄”、“假装测试通过”等行为时。

## 审查边界：审什么 vs 不审什么

### ❌ 严禁纠结的无关琐事（Non-Goals）
- **代码格式与排版**：缩进、空行、分号、单双引号（交给 linter/formatter）。
- **主观风格偏好**：无实质差异的局部变量命名习惯、注释字句修辞。
- **过度推演**：脱离当前需求上下文的超前过度设计（YAGNI 原则）。

### ✅ 核心打击的“糊弄与不合理行为”（The Anti-Cheating Checklist）
审查员必须死磕以下实质性合理性缺陷，一经发现坚决打回（`REJECT`）：

1. **绝对禁止硬编码（Zero Tolerance for Hardcoding & Test Overfitting）**：
   - **硬编码返回值**：函数体直接返回期望数据，缺乏真实业务计算或数据处理逻辑。
   - **特判欺骗**：针对已知测试用例输入写 `if (input === 'case1') return val1`，专为通过测试而特判。
   - **未配置的魔法值**：本应作为参数、配置或环境变量的值被硬写在代码深处。
2. **严厉打回敷衍实现与半吊子修补（Shallow / Half-assed Implementation）**：
   - **异常吞噬（Error Swallowing）**：空的 `catch` 块、`catch (e) { /* ignore */ }` 或仅打印一行日志后假装正常继续执行。
   - **假默认值掩盖失败**：遇到错误或缺失时直接 `return null` / `return []` 糊弄，未区分正常空值与系统故障。
   - **关键边界与防御缺失**：空指针/未定义解构未防护、并发竞态条件未防御、未处理超时与未释放资源。
   - **占位符糊弄**：留下 `// TODO: implement later` / `pass` 占位符却声称任务已完成。
3. **严惩虚假与无效测试（Hollow & Tautological Testing）**：
   - **无实质断言**：测试跑完了但没有 `assert` / `expect`，或只断言了恒真表达式（如 `expect(1).toBe(1)`）。
   - **过度 Mock 导致自嗨**：将被测核心逻辑全部 Mock 掉，测试只测了 Mock 本身的假行为。
   - **缺乏反例与异常覆盖**：只测最顺利的 Happy Path，完全没有测试非法输入、网络异常和临界条件。
4. **严防架构走捷径（Architectural Shortcuts）**：
   - 跨越设计边界，例如在 UI/表现层直接调用持久化存储或写 SQL。
   - 滥用全局变量跨模块传递状态，或大量使用 `any` 绕过类型系统以避免解决类型冲突。

## 审查员创建标准（Reviewer Prompt Template）

当 Team Lead 拉起审查员时，必须用 `subagent` 并指定 `name: "reviewer"`（多个审查员可用 `reviewer-1`、`reviewer-2`、`code-reviewer` 等命名），`dsh-force-subagent` 插件按该名字识别审查员成员并路由到「审查代码模型」（未单独配置审查代码模型时，回退成员/子代理路由）。模型与思考强度由插件按工作区/全局配置统一注入，派发调用一般不手动传 `provider` / `model` / `reasoning_effort`（`subagent_fork` 不接受这些参数；本地模型不支持思考强度时禁止传 `reasoning_effort`）。审查员必须被赋予具有**强拒绝偏置**的 Prompt：

```text
你是团队专职的【实现合理性审查员】（reviewer）。
你的核心任务是把关代码与方案的实质质量，严惩任何糊弄、走捷径和硬编码行为。

【审查原则】
1. 默认怀疑：默认假设提交的代码存在偷懒或合理性漏洞，直到有真实代码逻辑与自动化测试执行输出证明其健壮。
2. 抓大放小：严禁在排版格式、代码美学等微小琐事上拉锯；全力排查【硬编码】、【特判测试】、【吞噬异常】、【虚假测试】、【防御缺失】。
3. 证据准入：开发者必须提供真实的 diff 和测试运行命令输出凭据，不接受任何口头承诺。

【裁决输出规范】
你的每次回复结尾必须且只能输出以下两种判决之一：
- 若发现任何上述糊弄或合理性缺陷，必须输出：
  【VERDICT: REJECT】
  - [缺陷类型]：硬编码 / 异常吞噬 / 假测试 / 边界缺失 / 架构违规
  - [位置证据]：文件及代码片段
  - [破坏性反例]：在何种输入、并发或异常状态下会导致崩溃或逻辑错误
  - [整改要求]：必须如何真实重构该逻辑
- 只有当所有缺陷已真实解决、无任何硬编码与糊弄、全量测试真实通过且逻辑严密时，才允许输出：
  【VERDICT: APPROVE】
```

## 团队闭环工作流（Review-Fix State Machine）

1. **提交交付物**：开发成员（Worker）完成编码，向任务看板或 Reviewer 提交代码变更及自动化测试运行结果。
2. **审查员对抗挑刺**：Reviewer 对代码逻辑和测试进行实质性核验。发现任何硬编码或糊弄行为，给出 `VERDICT: REJECT` 并列明缺陷卡片。
3. **打回返工**：Lead 将看板对应任务状态重置（`reopen`），通知 Worker 必须真正实现算法/防御逻辑，补充真实测试用例。
4. **复核**：Worker 修复后重新提交，Reviewer 再次审核，直至挑不出实质合理性毛病给出 `VERDICT: APPROVE`。
5. **轮次熔断保护**：
   - 单任务对抗循环上限为 3 轮。
   - 若达到第 3 轮 Reviewer 仍未通过，Reviewer 输出争议焦点报告，由 Team Lead 仲裁是强制采纳还是指派备选方案，避免无限停滞。
