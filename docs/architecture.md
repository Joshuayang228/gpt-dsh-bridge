# Architecture — GPT controller + persistent DSH sessions

[English README](../README.md) · [中文 README](../README.zh-CN.md) · [ChatGPT computer connection](connect-chatgpt.md) · [API reference](../dsh-orchestrator/README.md)

## 1. Boundaries between layers

~~~mermaid
flowchart TB
    User["Human: goals and consequential approvals"]
    GPT["ChatGPT: orchestration<br/>What / Why / Constraints / Done"]
    Connector["Authorized computer connector<br/>Outside this repository"]
    CLI["dsho.ps1<br/>Local PowerShell client"]
    Plugin["dsh-orchestrator<br/>Authenticated loopback-only HTTP"]
    Native["DSH native controllers<br/>sessionController · workspaceController"]
    Workspace["Native Workspace<br/>Canonical project root"]
    A["Workstream A → Persistent Session A<br/>Agent + context + history"]
    B["Workstream B → Persistent Session B<br/>Agent + context + history"]

    User --> GPT --> Connector --> CLI
    CLI -->|"localhost authenticated"| Plugin --> Native --> Workspace
    Workspace --> A
    Workspace --> B
    Native -. "Read-only status and recorded evidence" .-> Plugin
    CLI -. "Separate GPT reminder when settled" .-> GPT
    GPT -. "Verified outcome / escalation" .-> User
~~~

**Responsibility split:**

| Layer | Owns | Does not own |
| --- | --- | --- |
| Human | Goal, value judgment, high-impact authorization | Routine implementation decisions |
| ChatGPT | Workstream routing, objective, constraints, acceptance criteria, Review | Every shell command or DSH internal plan |
| Computer connector | Authorized reachability to a local machine | Session semantics or model permission policy |
| `dsho.ps1` | Discover endpoint, read local DSH token, issue request, decorate final status | Agent implementation, an independent Session registry |
| `dsh-orchestrator` plugin | Local authenticated API over native DSH services | External network tunnel, persistence, arbitrary Session creation |
| DSH Agent | Inspect environment, implement, verify and report evidence | Silent scope expansion or user-level authorization |

The connector and DSH have separate permissions. Loopback-only HTTP **reduces network exposure**, but does not make arbitrary agent actions safe.

## 2. How workstreams map to Sessions

An existing project Workspace is identified by its canonical filesystem root. **Session ID is not a project ID.** For a GPT-managed workstream the human-readable title follows `GPT-<workstream>`, but title is not globally unique; route by **Workspace membership + exact title**, then retain the native Session ID.

~~~mermaid
flowchart TD
    START["New task / follow-up"] --> ROOT["Identify canonical project root"]
    ROOT --> WS{"Workspace exists?"}
    WS -->|"No"| ENSURE["workspace.ensure (native)"]
    WS -->|"Yes"| STREAM["Determine workstream"]
    ENSURE --> STREAM
    STREAM --> USER{"User explicitly selected an existing Session?"}
    USER -->|"Yes"| VALID["Verify cwd and Workspace identity"]
    VALID -->|"Compatible"| REUSE["Reuse that Session ID"]
    VALID -->|"Mismatch"| STOP["Stop and report conflict"]
    USER -->|"No"| MATCH{"Exact GPT-workstream title<br/>in this Workspace"}
    MATCH -->|"One"| REUSE
    MATCH -->|"More than one"| STOP
    MATCH -->|"None"| CREATE["Create new native Session<br/>only for this workstream"]
    CREATE --> DISPATCH["Dispatch goal + constraints + acceptance"]
    REUSE --> DISPATCH
~~~

**Don't** create a replacement Session to evade an active writer, busy Agent, transport failure or a Goal Round still running. When an existing Session must be attached to a Workspace, use the official `WorkspaceEntity.attachSession` method; never rewrite its recorded cwd to force it.

**Parallelism:** Split only into independent workstreams with no unmet dependencies, simultaneous writes to the same assets or duplicate external side effects. One workstream has one stable Session; one Session only owns one workstream. Let ChatGPT review each result and choose one integration owner if changes must be merged.

## 3. Task and verification lifecycle

~~~mermaid
sequenceDiagram
    autonumber
    actor Human
    participant GPT as GPT controller
    participant Client as dsho.ps1 + localhost plugin
    participant DSH as DSH native Session

    Human->>GPT: Goal + boundaries
    GPT->>Client: health, workspaces, sessions
    Client-->>GPT: Native identity and current status
    GPT->>Client: prompt(goal, context, constraints, acceptance)
    Note over Client,DSH: Client appends Runtime Contract from dsh-handoff.md
    Client->>DSH: Queue prompt
    DSH->>DSH: Inspect, implement, test
    opt Risk or material change of scope
        DSH-->>GPT: Report blocker / choice, request authorization
    end
    GPT->>Client: status -Wait
    alt Still running / timeout / stream-ended
        Client-->>GPT: Not settled
        GPT->>Client: Continue waiting in the SAME Session
    else Settled with final reply
        Client-->>GPT: DSH result + separate gptReviewReminder
        GPT->>GPT: Inspect evidence vs acceptance criteria
        alt Unverified or incomplete
            GPT->>Client: Rework gap, same Session
        else Verified
            GPT-->>Human: Accepted result + evidence
        end
    end
~~~

The outbound **Runtime Contract** and inbound **GPT review reminder** both come from the single source `agent-skills/dsh-handoff.md`. The reminder is added to a separate client response field, not written into the DSH conversation or into its five-block report.

## 4. Status semantics matter

| Observation from `status -Wait` | Meaning | GPT behavior |
| --- | --- | --- |
| `waitOutcome: idle` and `running: false` with a final turn | A turn has settled | Review evidence; do not accept automatically |
| `waitOutcome: already-idle` | Session was idle before subscribing | Review its recorded last turn; verify it is the relevant task |
| `timeout` | Wait budget expired | Continue on the same Session; don't start a substitute |
| `stream-ended` | Follow stream ended without verified settled status | Re-query status and continue safely |
| `running: true` | Session still active | Do not mark complete, even if a Goal Round emitted `turn/end` |
| `textTruncated: true` | Last text was capped | Inspect other evidence; don't assume the report is complete |

An already-idle Session can include a **previous** final turn. A status query alone does not establish which task was accepted; the GPT controller must correlate the Session and requested work.

## 5. Security and trust

The plugin only binds to validated loopback addresses and authenticates **every** route with a bearer token managed in DSH's credential store. Endpoint discovery is a non-secret file. The client never prints the token.

The plugin does not auto-escalate DSH sandbox permissions. Sandbox controls are separate, explicit operations. Never treat permission errors as an invitation to change modes automatically. Likewise, a connected remote computer tool may have broader permissions than the plugin; it needs its own authorization and operational controls.

See [SECURITY.md](../SECURITY.md) and the [actual plugin code](../dsh-orchestrator/lib/).

## 6. Why this architecture instead of another runtime?

- **Native state:** Workspace, Session, Agent, logs and Web UI belong to DSH; the bridge does not duplicate them.
- **Thin control surface:** authenticated HTTP on localhost, with stable explicit operations.
- **Recoverable continuity:** long-running work resumes the same Session after user or GPT interruption.
- **Separation of concerns:** GPT handles delegation and Review while DSH performs in-scope implementation.
- **Honest limitations:** no automatic ChatGPT cloud integration, remote tunnel or clean-machine compatibility guarantee beyond the tested versions.

For a complete runnable task and a deliberately failing fixture, see [examples/README.md](../examples/README.md).
