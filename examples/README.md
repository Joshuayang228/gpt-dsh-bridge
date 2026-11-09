# Hands-on demo: ChatGPT → DSH → test evidence → ChatGPT Review

[English README](../README.md) · [中文 README](../README.zh-CN.md) · [Architecture](../docs/architecture.md)

This demonstration uses an **intentionally broken invoice calculator**. You run a failing test, then direct ChatGPT—through your **already authorized computer connector**—to delegate the repair to DSH and Review its evidence.

> **Safety:** Work in a disposable copy, not in the original repository or a production project. This tutorial does not ask you to alter DSH permissions automatically, install an untrusted agent, or copy credentials into chat.

## 1. Understand the starting state

The fixture in `sample-project/` has two tests. `invoiceTotal` ignores `quantity`, so the quantity test fails:

~~~text
Input:
  3 items × 12 = 36
  2 items ×  7 = 14
Correct total: 50
Buggy total:  19
~~~

From the repository root:

~~~powershell
node --test .\examples\sample-project\test\invoice.test.mjs
~~~

**Expected before repair:** one test passes and one test fails (`19 !== 50`). This is intentional.

## 2. Create an isolated work copy

Use a new temporary directory. Keep the PowerShell session open for the next steps:

~~~powershell
$repo = (Get-Location).Path  # must be the gpt-dsh-bridge repository root
$demo = Join-Path $env:TEMP ("gpt-dsh-invoice-" + [guid]::NewGuid().ToString("N"))
Copy-Item -LiteralPath (Join-Path $repo "examples\sample-project") -Destination $demo -Recurse
Write-Output "Disposable work root: $demo"
~~~

Do not copy the whole personal project folder or any production documents.

## 3. Find the correct DSH Workspace and Session

Your DSH Web Host must already be running with the `dsh-orchestrator` plugin. In the same terminal:

~~~powershell
$dsho = Join-Path $repo "tools\dsho.ps1"
& $dsho health

$workspaceEnvelope = (& $dsho ensure -Path $demo) | ConvertFrom-Json
$workspaceId = $workspaceEnvelope.result.workspace.workspaceId

$sessionEnvelope = (& $dsho sessions) | ConvertFrom-Json
$candidates = @($sessionEnvelope.result.items | Where-Object {
    ($workspaceEnvelope.result.workspace.sessionIds -contains $_.sessionId) -and
    $_.title -eq "GPT-invoice-demo" -and
    $_.archived -ne $true -and
    $_.origin -ne "subagent"
})

if ($candidates.Count -gt 1) {
    throw "Multiple matching Sessions: stop and resolve the routing conflict"
}
if ($candidates.Count -eq 1) {
    $sessionId = $candidates[0].sessionId
} else {
    $created = (& $dsho new -Workstream "invoice-demo" -WorkspaceId $workspaceId) | ConvertFrom-Json
    $sessionId = $created.result.sessionId
}
Write-Output "Use Session: $sessionId"
& $dsho sandbox -Session $sessionId
~~~

These are **illustrative operator commands**, not a guarantee that the DSH service is present on a new machine. If health, workspace registration or Session creation fails, resolve that first. **Do not** proceed with an empty Session ID, bypass a busy Session or silently elevate the sandbox.

## 4. Tell ChatGPT to delegate, not micromanage

Copy this instruction into a ChatGPT conversation that already has permission to use your local computer:

> On my authorized computer, find the checked-out gpt-dsh-bridge repository. Read `agent-skills/dsh-orchestrator/SKILL.md` and `agent-skills/dsh-handoff.md`. Use the disposable invoice demo Workspace and its existing `invoice-demo` Session if one exists. Delegate the goal in `examples/demo-task.md` to DSH, allowing DSH to choose the implementation. Do not modify the original repository or unrelated files. After DSH settles, verify that the actual Node test passes before accepting the result.

Alternatively, if you want to exercise the CLI without ChatGPT, dispatch directly:

~~~powershell
& $dsho prompt -Session $sessionId -TextFile (Join-Path $repo "examples\demo-task.md")
~~~

**Goal and bounds** matter more than an exact patch specification. The DSH Agent should inspect `src/invoice.js`, decide how to fix it and run the test itself.

## 5. Wait for settled evidence

~~~powershell
& $dsho status -Session $sessionId -Wait -TimeoutMs 120000 -Pretty
~~~

If the result says `running: true`, `timeout` or `stream-ended`, the work **has not been proven complete**. Continue waiting on the **same Session**. Do not create a replacement Session because an answer is delayed.

For a settled final reply, expect DSH's five report blocks: **结果 / 关键发现 / 变更 / 验证 / 未解决·风险**. The CLI may also add `gptReviewReminder` outside the DSH report, reminding ChatGPT to Review evidence and avoid over-prescribing implementation.

## 6. Review, rather than trusting the word "done"

Run the test **against the disposable copy**, not the original broken fixture:

~~~powershell
Push-Location $demo
node --test .\test\invoice.test.mjs
Pop-Location
~~~

ChatGPT should confirm that:
- Tests actually pass with exit code 0 and the correct total `50`.
- Only in-scope sample files were edited.
- Unverified behavior or blockers were reported honestly.

If anything fails, state the evidence gap and send a follow-up to the **same** `invoice-demo` Session.

### Example of the desired final result (illustrative only)

~~~text
DSH candidate:
  结果：成功
  变更：src/invoice.js — include quantity in invoiceTotal
  验证：node --test test/invoice.test.mjs — 2 passed, 0 failed

GPT review:
  Confirmed the same test independently in the disposable Workspace.
  Accepted the fix and returned the summary to the user.
~~~

This is an example of the **expected successful outcome**, not a transcript of a live DSH run performed for this repository.

## Two more task patterns

### Read-only investigation

See [read-only-investigation.md](tasks/read-only-investigation.md). Give DSH a diagnostic goal and an explicit **do not modify files** boundary. Review concrete error output or findings.

### Parallel independent workstreams

See [parallel-workstreams.md](tasks/parallel-workstreams.md). Route truly independent work to distinct Sessions, and ensure only one lane writes any shared integration state.

## Reset

The demo copy was created under a new temporary directory. Remove **only that specific directory** after confirming its value is no longer needed. Never delete an arbitrary Workspace or original repository path just to reset an example.
