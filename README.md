# gpt-dsh-bridge

**ChatGPT plans and reviews. DeepSeek Harness executes in persistent local sessions.**

[简体中文](README.zh-CN.md) · [Connect ChatGPT to your computer](docs/connect-chatgpt.md) · [Full architecture](docs/architecture.md) · [Runnable demo](examples/README.md) · [Security](SECURITY.md)

> **Status:** v0.1.0 publication candidate. Unit tests pass; a clean-machine live-host installation and license/ownership review are still pending. **Not an official OpenAI or DeepSeek project.**

## See it in 30 seconds

You ask ChatGPT:

> "Fix the invoice calculation in my project. Run the tests and show me what changed."

ChatGPT identifies the project and existing DSH workstream, delegates the **outcome** instead of writing every shell command, and checks the evidence when DSH finishes. If more work is needed, it continues the **same Session**.

~~~mermaid
flowchart TB
    U["👤 User<br/>Goal / approval"] --> G["🧠 ChatGPT · Orchestrator<br/>Goal · scope · routing · Review"]
    G --> C["Authorized computer connector<br/>e.g. Remote Desktop Commander"]
    C --> CLI["tools/dsho.ps1<br/>PowerShell client"]
    CLI -->|"Authenticated HTTP · localhost only"| P

    subgraph HOST["Your computer · resident DSH Web Host"]
        P["dsh-orchestrator plugin<br/>Native DSH controller APIs"]
        subgraph WS["Native Workspace · project root"]
            A["Session A · bug fixes<br/>DSH Agent + durable context"]
            B["Session B · docs<br/>DSH Agent + durable context"]
        end
        P --> A
        P --> B
    end

    A -. "Status + evidence" .-> P
    B -. "Status + evidence" .-> P
    CLI -. "Result + GPT-only review reminder" .-> G
    G -. "Accept / rework / escalate" .-> U
~~~

**The key is not another agent runtime.** The plugin uses DSH's native Workspace, Session and Agent APIs. The GPT layer owns decisions and acceptance; DSH owns in-scope implementation and verification.

## Why use it?

| Problem | How this project handles it |
| --- | --- |
| An agent forgets everything between calls | The same workstream resumes its **native persistent DSH Session** |
| The controller micromanages every command | A task handoff SOP separates **goal/constraints/acceptance** from **implementation** |
| "Done" is mistaken for success | DSH reports evidence; **ChatGPT makes the final acceptance decision** |
| A busy Session leads to duplicate work | **No fallback Session** to bypass locks, busy turns or temporary failures |
| One project has multiple independent tasks | **Separate workstreams** can use separate Sessions, with shared-write checks |
| The controller forgets its role after a long run | A separate **`gptReviewReminder`** is returned with a settled final result |

### What the roles mean

- **You:** choose the outcome, authorize consequential actions and make high-impact decisions.
- **ChatGPT (controller):** clarify objectives, constraints, acceptance, Workspace/Session routing, coordination and evidence Review.
- **DSH (worker):** inspect the environment, choose implementation steps, execute, test, fix routine failures and report evidence.
- **`dsho.ps1` + plugin:** reliable transport and native Session control, **not** another planning model.

## A full task lifecycle

~~~mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant G as ChatGPT
    participant C as dsho.ps1 / local plugin
    participant D as Persistent DSH Session

    U->>G: Fix the invoice total and verify it
    G->>C: Inspect Workspaces and Sessions
    C-->>G: Existing Session ID, or no match
    opt No reusable Session for this workstream
        G->>C: Create a Session in the existing project Workspace
    end
    G->>C: Send goal + context + boundaries + acceptance
    C->>D: Prompt with Runtime Contract
    D->>D: Inspect, implement, test, report evidence
    G->>C: status -Wait
    C-->>G: Settled DSH report + separate GPT reminder
    G->>G: Review against acceptance criteria
    alt Evidence missing or tests failing
        G->>C: State the gap, continue the SAME Session
    else Accepted
        G-->>U: Summary + verified evidence
    end
~~~

**Session rules:** One continuous workstream → one reusable Session. One Session should not own two independent workstreams. Independent workstreams may run in parallel only when dependencies, shared files and external side effects allow. The human DSH Web UI can view and continue the same native Session.

## Quick start — 5 steps

### 0. Prerequisites

- **Windows** with PowerShell 5.1 or 7 for the current CLI.
- Node.js 20+ for plugin development and tests.
- DeepSeek Harness **`0.2.0-rc.2` or `0.2.1-rc.2`** (the tested compatibility targets; later versions are **not** yet supported by claim).
- A DSH **Web** host. This plugin uses the Web profile's Session controller, not the headless profile. **Configure a working model provider in DSH Web UI → Settings → Models before expecting an Agent prompt to complete.** Do not put model/API keys in this repository.
- To delegate from ChatGPT: an **authorized computer connector** that can execute the CLI on your machine. This repository does **not** grant an ordinary ChatGPT chat access to local files or computers. **[Follow the connection tutorial first](docs/connect-chatgpt.md)** (Remote Desktop Commander example, with a separate computer connection check and DSH health check).

The [official DeepSeek Harness site](https://www.deepseek.com/en/harness/) links to DSH installation and source instructions.

### 1. Install the plugin

Run in PowerShell from the **root of this repository**:

~~~powershell
$pluginDir = (Resolve-Path -LiteralPath .\dsh-orchestrator).Path
dsh plugin --profile web add "file:$pluginDir"
~~~

### 2. Start the DSH Web host

Start or **safely restart** it after plugin installation. Do not interrupt valuable running turns:

~~~powershell
dsh web --host 127.0.0.1 --port 3080 --no-open
~~~

Keep that terminal alive. Run the following commands in a **second** PowerShell terminal, from the repository root:

~~~powershell
.\tools\dsho.ps1 health
~~~

Expect `ok: true` and healthy capabilities. The plugin accepts **loopback-only** connections with a DSH-managed bearer token; do not copy the token into chat, logs or screenshots.

### 3. Create or reuse the project Workspace

~~~powershell
.\tools\dsho.ps1 ensure -Path "D:\path\to\your-project"
.\tools\dsho.ps1 workspaces
.\tools\dsho.ps1 sessions
~~~

Match the Workspace by its **canonical project path**; locate Sessions by exact `GPT-<workstream>` title **inside that Workspace** (or use a user-selected Session after confirming its context).

### 4. Start a Session only when needed, then delegate

For a genuinely new workstream, take the `workspaceId` returned above:

~~~powershell
.\tools\dsho.ps1 new -Workstream "invoice-demo" -WorkspaceId "<workspace-id>"
.\tools\dsho.ps1 prompt -Session "<session-id>" -TextFile ".\examples\demo-task.md"
~~~

For a continuing workstream, skip `new` and use its existing `sessionId`. A task card gives **outcome, essential context, allowed scope, prohibited actions, acceptance and evidence**—not an unnecessarily long list of commands.

### 5. Wait, inspect evidence, then accept or rework

~~~powershell
.\tools\dsho.ps1 status -Session "<session-id>" -Wait -TimeoutMs 120000 -Pretty
~~~

`running: true`, `timeout` and `stream-ended` **do not mean completion**. Continue waiting on the same Session. Multi-round DSH Goals can also outlive a single turn. When settled, review the final evidence; rework goes back to the original Session.

The client attaches the DSH **Runtime Contract** to outbound prompts and returns a separate **`gptReviewReminder`** on eligible settled results. This does not change DSH's five-block report.

## Try a real, safe demo

We ship a deliberately broken **invoice calculator**, not a fabricated screenshot or a claim of a completed live Agent run.

~~~text
examples/sample-project/
├── src/invoice.js           # intentionally ignores quantities
├── test/invoice.test.mjs     # expected: 50; before fix: 19
└── package.json
~~~

**Before delegation**, run from the repository root:

~~~powershell
node --test .\examples\sample-project\test\invoice.test.mjs
~~~

One test passes; the quantity test intentionally fails. Use a **disposable copy** of the sample so DSH doesn't modify the repository itself. Then ask ChatGPT:

> Read `agent-skills/dsh-orchestrator/SKILL.md` and `agent-skills/dsh-handoff.md` from this repository on my authorized computer. Delegate the invoice demo in `examples/demo-task.md` to the correct DSH Workspace/Session. Let DSH decide how to fix it. Confirm that the test actually passes and show the evidence before accepting the result. Reuse a matching Session if one exists.

For the copy commands, exact routing walkthrough and review checklist, see **[the complete hands-on tutorial](examples/README.md)**.

### Other tasks worth delegating

| Example | Objective handed to DSH | GPT acceptance |
| --- | --- | --- |
| **Bug fix** | Fix the quantity bug without unrelated edits | Unit tests pass; diff stays in scope |
| **Read-only investigation** | Find why a local test intermittently fails; do not edit files | Reproducible findings and relevant logs |
| **Two independent tracks** | Review documentation in one Session and test coverage in another | Separate evidence and no conflicting writes |

**Illustrative tasks only:** these are workflows you can run, **not recorded real DSH outcomes**.

## Connect ChatGPT — what actually gets loaded?

ChatGPT needs an authorized computer bridge and access to two files in the checkout:

1. [`agent-skills/dsh-orchestrator/SKILL.md`](agent-skills/dsh-orchestrator/SKILL.md) — how to connect, find/reuse Sessions, dispatch, wait and recover.
2. [`agent-skills/dsh-handoff.md`](agent-skills/dsh-handoff.md) — what GPT and DSH should each own, escalation rules and evidence requirements.

**Not magic:** merely cloning the repo does not install a global ChatGPT Skill, schedule autonomous work or give ChatGPT computer permissions. DSH Web Host must run separately. The bridge must be configured by the user.

## Repository layout

~~~text
dsh-orchestrator/
  lib/                 # authenticated localhost control plugin
  test/unit-*.mjs      # tests that do not require a live DSH host
  README.md            # API details
tools/dsho.ps1         # thin PowerShell client
agent-skills/
  dsh-orchestrator/SKILL.md  # ChatGPT control guide
  dsh-handoff.md             # task, risk, review, GPT reminder
examples/              # intentionally failing isolated demo + task card
docs/architecture.md   # detailed diagrams and design decisions
~~~

## Test the code (no live host needed)

~~~powershell
Push-Location .\dsh-orchestrator
$tests = @(Get-ChildItem .\test -Filter 'unit-*.mjs' -File | ForEach-Object FullName)
node --test $tests
Pop-Location
~~~

The current public candidate passed **126 unit tests**, including a fresh-archive extraction test. That is **not** a claim that a clean-machine live installation has been verified.

## Security, limits and FAQ

- **Is this official?** No—an independent community project, not endorsed by OpenAI or DeepSeek.
- **Does it let ChatGPT access my computer automatically?** No; you must authorize/configure a separate computer connector.
- **Can it run without DSH Web Host?** No; the plugin uses the Web profile's native controller services.
- **Why not just use `dsh --profile headless` for every task?** Native Web Sessions retain Workspace ownership, persistent context and human-visible state without a second routing database.
- **Why not use a second Session when one is busy?** That can duplicate work and lose context; queue, wait or recover the original.
- **Is it safe on production systems?** Not assumed. Read [SECURITY.md](SECURITY.md), start with narrow workspaces, and never auto-escalate permissions.

See [architecture and protocol diagrams](docs/architecture.md), [API reference](dsh-orchestrator/README.md), [contribution guide](CONTRIBUTING.md) and [LICENSE](LICENSE) (MIT). Review ownership and licensing before publishing a public repository.
