# DSH Handoff — ChatGPT ↔ DSH

This file is the **task delegation and acceptance protocol**. The operational route, command syntax and recovery behavior are in [dsh-orchestrator/SKILL.md](dsh-orchestrator/SKILL.md).

## Responsibility split

- **ChatGPT defines what, why, constraints and done**: objective, essential context, scope, routing, user decisions and evidence-based Review.
- **DSH chooses most of how**: inspect environment, implement, diagnose, test and report the actual evidence.
- DSH acts autonomously on reversible, low-risk decisions within scope.
- Major change of goal, irreversible operation, material permission expansion, significant approach fork or repeated failure must be escalated.
- DSH's completion is a candidate outcome; ChatGPT decides acceptance based on evidence.

## Workstream and Session discipline

A project root identifies the Workspace; a continuous workstream owns one durable DSH Session.

- Continue the same Session for implementation, test fixes, review rework and interrupted work.
- Do not open another Session only because of a writer lock, busy agent or temporary transport failure.
- Do not mingle sibling workstreams in one Session. Independent workstreams can run in parallel if they don't conflict on dependencies, files, external side effects or shared state.
- GPT-created Sessions use `GPT-<workstream>` titles. A human-provided Session can also be reused after checking the context.
- Reuse previously accepted results; avoid re-running completed work for no reason.

## Task card

```text
Task: <short description>
Project root: <the real project directory, not a temporary prompt directory>
Workstream / Session: <stable workstream and existing Session, or reason for new>
Goal: <required outcome>
Context: <relevant known facts, files, previous results>
Scope:
- DSH may decide: ...
- Must not do: ...
- Escalate before: ...
Acceptance criteria: <observable outcomes>
Evidence needed: <verification commands/results, changed files, blocking risks>
```

Only requirements that constrain the outcome belong in the task card. Do not convert ChatGPT's guesses about specific commands and implementation steps into mandatory instructions unless that implementation is itself part of the requirement.

Long tasks can explicitly ask DSH to use its **native Goal mode**. Don't start it for a single query or a short task.

## Escalation

DSH can normally read relevant project files and logs, run diagnostics, edit reversible in-scope files, and run existing build/test/lint commands.

Escalate for destructive or hard-to-revert changes, deletion/overwriting of unknown assets, security/permission/credential changes, exposure of local data, public publishing, external side effects, a changed goal or significantly different solution choice, or failure of the same path twice.

## DSH final report

The final response is written primarily for ChatGPT Review, not as a direct end-user narrative. Use these five blocks, in order:

```text
结果：成功 / 部分成功 / 阻塞
<one or two sentences with the actual final state>

关键发现：
- Only facts that change the judgment or assumptions

变更：
- Files / configuration / behavior actually changed

验证：
- What was actually tested and the observed result
- If untested: explicitly state 未验证 and why

未解决 / 风险：
- Real risks, blockers and necessary follow-up; otherwise 无
```

Do not replace evidence with "Done". Avoid an investigation diary; retain it in the Session and summarize only findings that affect the judgment. Use the project's established terminology and avoid invented labels.

## ChatGPT acceptance

1. Compare the result with the task's original acceptance criteria.
2. Inspect evidence, not just claims of success.
3. Independently spot-check important files, commands or output when needed.
4. If it fails: describe the acceptance gap and desired correction; reuse the original Session.
5. If it passes: record the accepted milestone in the project's own progress record.

## Runtime Contract (injected into every outbound DSH task)

Only the text between the markers below is appended by `tools/dsho.ps1` at dispatch time. Maintain exactly one source here.

<!-- RUNTIME-CONTRACT:START -->
- 最终回复固定五块：结果 / 关键发现 / 变更 / 验证 / 未解决·风险。
- 只保留影响判断的事实，不复述完整调查过程。
- 未实际验证的，必须明确写“未验证”并说明原因。
- 优先使用项目已有术语和普通技术语言；不要为了总结自造概念、层级、模式或比喻。
- 最终回复主要供上层 GPT Review 消费，以事实和证据为主。
- 当前任务若明确规定其他输出格式，以当前任务的显式要求为准。
<!-- RUNTIME-CONTRACT:END -->

## GPT reminder (returned separately after a settled final turn)

This is guidance for the controller, not part of DSH's five-block final report. `tools/dsho.ps1` adds it in the `gptReviewReminder` field only when `status -Wait` has a settled final DSH message.

<!-- GPT-REVIEW-REMINDER:START -->
**上层 GPT 协作提醒（非 DSH 执行结果）**

请遵循 `agent-skills/dsh-handoff.md` 中的协作规范。如果本会话已读取且规范未变化，无需重复读取；否则请先读取。

**职责分工：** GPT 明确目标、必要背景、边界与验收标准，负责任务路由，并根据证据 Review 和决定是否验收。DSH 在授权范围内自主决定实现方式、执行和自测；低风险、可逆的选择不逐项请示，重大风险、不可逆操作或方案变化须上报。

**避免以下行为：**
1. 过度微操：不要替 DSH 规定具体命令、脚本和实施步骤，除非这些本身就是必要约束。
2. 重复劳动：优先复用已有文档、历史结果及 Session 上下文，不重复已验收的工作。
3. 职责越界：不要代替 DSH 大量执行本应委派的任务；必要时可独立核查关键证据。
4. 错误路由：同一连续工作块复用原 Session，不因繁忙或失败随意新建；独立工作块可按需并行。

**协作原则：** 减少对用户的不必要打扰；只在需要决策、真正阻塞或已有可用结果时主动汇报，用户主动询问进度时正常回应。任务范围内的问题优先交给 DSH 处理，GPT 重点负责跨工作块协调、重大决策及最终验收。

**Review：** DSH 的完成报告只是候选结果。GPT 根据实际证据判断通过、返工或停止；返工时只指出差距，不重新微操执行过程。
<!-- GPT-REVIEW-REMINDER:END -->
