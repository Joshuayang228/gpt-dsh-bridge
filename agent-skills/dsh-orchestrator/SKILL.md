---
name: dsh-orchestrator
description: Route ChatGPT's local execution work to durable DSH Web sessions through the authorized computer bridge and tools/dsho.ps1. Reuse native Workspaces and Sessions, wait, verify, and recover without extra session registries.
version: 1
requires:
  dsh: 0.2.0-rc.2 || 0.2.1-rc.2
  orchestrator_api: v1
---

# ChatGPT → DeepSeek Harness (DSH) orchestration

## When to use

Use when ChatGPT should delegate local investigation, coding, debugging, batch edits, or verification to a DSH Agent, while retaining responsibility for the goal, scope, risk and final evidence-based review.

A connected computer tool is a prerequisite; ChatGPT cannot run local PowerShell by itself without a computer bridge. Use the actual repository path on the user's authorized machine and read `../dsh-handoff.md` before the first delegation.

```text
User → ChatGPT (goal / constraints / acceptance / review)
     → authorized computer bridge
     → <repository>/tools/dsho.ps1
     → localhost-only dsh-orchestrator plugin in resident DSH Web Host
     → DSH native Workspace / Session / Agent
```

## Invariants

- Project identity is the canonical project root, **not** a Session ID.
- One continuous workstream reuses one healthy DSH Session. A Session owns one workstream.
- A workstream isn't duplicated simply because its existing Session is busy, locked, slow, or had an error.
- Different independent workstreams can use distinct Sessions in parallel when dependencies, shared mutations and external side effects permit.
- GPT-created Sessions use the native title `GPT-<workstream>`; the stable ID remains `sessionId`.
- Never edit DSH session logs, Workspace state or projection caches directly.
- Use the authenticated `dsho.ps1` client instead of writing custom token-handling calls.
- `prompt` defaults to queue; `-Steer` is reserved for deliberately changing an actively running turn.
- A report that says "Done" is only a candidate result. ChatGPT reviews evidence and decides to accept, rework, or stop.

## Find the client

Locate the checked-out repository root on the authorized computer and resolve:

```powershell
$repo = "D:\path\to\gpt-dsh-bridge"  # example; replace with actual path
$dsho = Join-Path $repo "tools\dsho.ps1"
& $dsho health
```

Do not assume a developer-specific absolute path. Never display or copy the DSH control token. `health` must return a successful envelope with healthy capabilities and loopback-only listener.

## Workstream routing (before every first prompt)

1. Identify the real target project root and the stable workstream name.
2. Read DSH native Workspaces and Sessions:

```powershell
& $dsho workspaces
& $dsho sessions
```

3. Match a Workspace using canonical project path, not its display title. If absent, use:

```powershell
& $dsho ensure -Path "D:\path\to\your-project"
```

4. Within that Workspace, match a non-archived, top-level Session with the **exact** title `GPT-<workstream>`.
5. Exactly one match → reuse its Session ID; more than one → stop and report a conflict; none → create only when the workstream is genuinely new:

```powershell
& $dsho new -Workstream "test-fixes" -WorkspaceId "<workspace-id>"
```

A user-specified existing Session ID takes precedence after confirming that its cwd and Workspace match the project. A human-created Web Session can be reused without renaming it.

Do not choose the most recently updated Session, silently reroute to another project, or create another Session to bypass a writer lock.

## Dispatch

Write a task card with objective, essential background, boundary, acceptance criteria and evidence required. Avoid prescribing implementation steps that DSH can decide.

```powershell
& $dsho prompt -Session "<session-id>" -TextFile "D:\path\to\task.txt"
```

Short follow-up prompts may use `-Text`. The client appends the handoff document's single Runtime Contract automatically. Do **not** manually paste the contract into every task.

For long multi-round investigation/implementation/verification tasks, the task text may ask DSH to enter its **native Goal mode**. There is no `dsho goal` API; simple one-turn tasks should not enable Goal mode.

## Wait without disturbing state

```powershell
& $dsho status -Session "<session-id>"
& $dsho status -Session "<session-id>" -Wait -TimeoutMs 120000
```

- `timeout`, `stream-ended`, or `running: true` mean **not settled**. Continue waiting in the same Session; do not claim completion.
- A Goal Round may emit a `turn/end` before its multi-round session becomes idle. Review only after the full work has settled.
- A settled result with a final assistant message may include `gptReviewReminder`. It is for GPT and separate from the DSH result.
- If the last text was truncated, retrieve other evidence rather than interpreting absence of details as success.

## Review and rework

Compare DSH's evidence against the original acceptance criteria. The five report blocks are: Result, Key Findings, Changes, Verification, Outstanding / Risks. Optionally inspect relevant local files or test results through the authorized computer tool.

If verification is insufficient, send **the gap and the desired corrected outcome** back to the same Session rather than micro-managing every shell step. If DSH has to change the target, take irreversible action, or exceed authorization, request the necessary user decision first.

## Safety and recovery

- Start with read-only health diagnosis. The endpoint discovery file is **not** proof that a host is running.
- If the DSH Web host is not running, restarting it may disrupt active work; do not blindly stop or start background processes on behalf of the user.
- An `active writer`, `agent busy` or a failed prompt is not a new-Session exception. Inspect and wait or report, do not bypass it.
- Session attachment uses DSH's official ownership API; do not rewrite historical cwd to force attachment.
- Sandbox restrictions are authoritative. Use `& $dsho sandbox -Session "<id>"` to read the effective posture. A mode switch is an explicit high-impact action; never auto-escalate on failure.
- Prefer preserving the live DSH host and its sessions over brute-force restart.
- Never publish machine-specific paths, control tokens, credentials or real session logs.

See [handoff SOP](../dsh-handoff.md), [plugin API](../../dsh-orchestrator/README.md) and [security guidance](../../SECURITY.md).
