# dsh-orchestrator (DSH Web plugin)

A small, authenticated, **localhost-only** control surface over DSH's official Workspace and Session services. It is the runtime piece of [gpt-dsh-bridge](../README.md).

## Design

- Mounts in a resident **DSH Web host**, not a headless profile.
- Uses DSH's native `sessionController`, `workspaceController` and `WorkspaceEntity.attachSession`.
- Uses native Session identity, title, logs and Workspace state. **No parallel session registry.**
- Creates Sessions only through the explicit create endpoint. Busy Sessions are never replaced silently.
- Exposes the effective sandbox policy and requires an explicit switch. No automatic escalation.
- Listens on a strictly allowlisted loopback host, with authenticated requests on all routes.

## Compatibility

- Node.js 20+
- DeepSeek Harness `0.2.0-rc.2` or `0.2.1-rc.2` only, unless a newer version has been tested and the compatibility gate deliberately updated.

## Install into the DSH web profile

From the repository root:

```powershell
$pluginDir = (Resolve-Path -LiteralPath .\dsh-orchestrator).Path
dsh plugin --profile web add "file:$pluginDir"
# Start/restart web host when safe:
dsh web --host 127.0.0.1 --port 3080 --no-open
.\tools\dsho.ps1 health
```

The Web profile supplies the session controller. The plugin's `cordis.patch.yml` supplies default configuration. Change profile config only when you understand DSH's configuration precedence.

## Configuration defaults

```yaml
- id: dsh-orchestrator
  name: dsh-orchestrator
  config:
    host: '127.0.0.1'      # only 127.0.0.1, ::1, localhost
    port: 0                # OS-selected local port
    allowUntestedVersion: false
    requestTimeoutMs: 30000
    waitTimeoutMs: 120000
    waitTimeoutMaxMs: 600000
```

A live host publishes a non-secret discovery record at `<DSH_HOME>/orchestrator/endpoint.json`. The bearer token is stored in DSH's own credential store as `dsh-orchestrator/control-token`; it is never included in the discovery file or health response. The thin client reads this token locally. Every route, including health, requires authentication.

## HTTP API

Base: `http://127.0.0.1:<discovered-port>`. Responses use `{ "ok": true, "result": ... }` or `{ "ok": false, "error": { "code": "...", "message": "..." } }`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/health` | Service, version and capability report |
| GET | `/v1/workspaces` | Native Workspace rows and Session ownership |
| POST | `/v1/workspaces/ensure` | `{path}` idempotent Workspace creation/reuse |
| GET | `/v1/sessions` | Sessions, optionally `?includeArchived=true` |
| POST | `/v1/sessions` | `{workstream,workspaceId? ,cwd? ,agentPreset?}` creates `GPT-<workstream>` |
| POST | `/v1/sessions/:id/attach` | `{workspaceId}` official Workspace attachment |
| POST | `/v1/sessions/:id/rename` | `{title}` or `{workstream}` |
| POST | `/v1/sessions/:id/prompt` | `{text,mode?,requestId?}`, default queue |
| GET | `/v1/sessions/:id/status` | Read-only status, `?wait=idle&timeoutMs=...` |
| GET | `/v1/sessions/:id/sandbox` | Effective sandbox policy |
| POST | `/v1/sessions/:id/sandbox` | Explicit `{mode}` update |
| POST | `/v1/sessions/:id/cancel` | Cancel an active session turn |

The title is human-readable and not a globally unique identity. Routing must match the exact title **within** the canonical project Workspace. More than one exact match is a conflict, not an excuse to pick the newest.

When waiting, `status` can return `waitOutcome` of `not-requested`, `already-idle`, `idle`, `timeout` or `stream-ended`. A `turn/end` inside a multi-round Goal does not guarantee the Session is completely idle. The last assistant text is bounded and can be marked `textTruncated`.

## Client-only behavior

`tools/dsho.ps1` adds two **local** features that do not alter the HTTP plugin: outbound prompts receive the Runtime Contract; settled final status results may receive an independent `gptReviewReminder`. Both textual blocks are extracted from `agent-skills/dsh-handoff.md` rather than copied into source code.

## Tests

```powershell
$tests = @(Get-ChildItem .\test -Filter 'unit-*.mjs' -File | ForEach-Object FullName)
node --test $tests
```

The unit suite does not need a running DSH Web host or access to model credentials. A separate real-host acceptance check is needed before declaring compatibility with other DSH versions.
