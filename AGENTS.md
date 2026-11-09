# gpt-dsh-bridge — Contributor instructions

This repository is the **public distribution copy** of a ChatGPT-to-DSH orchestration workflow. Keep it independent of any contributor's private workspace or credentials.

## Responsibilities

- ChatGPT/controller: define goals, constraints, route workstreams and review evidence.
- DSH/worker: select implementation details, execute and verify inside its scope.
- Prefer reusing one native DSH Session per continuous workstream.
- Never create a Session only to avoid a busy writer, stale connection or failed attempt.
- Treat DSH "done" as a candidate result until independently reviewed.

## Repository layout

- `dsh-orchestrator/`: DSH Web-profile plugin and unit tests.
- `tools/dsho.ps1`: client using the loopback control API.
- `agent-skills/dsh-orchestrator/SKILL.md`: operational instructions for ChatGPT.
- `agent-skills/dsh-handoff.md`: task / escalation / review agreement.
- `docs/`: public architecture and release progress.

## Change discipline

- Do not introduce absolute personal paths, secrets or company-specific data.
- Do not weaken loopback-only authentication, permission boundaries or native Workspace/Session ownership semantics.
- Update unit tests for changed client/API behavior. Run all `unit-*.mjs` tests before publishing.
- Keep the outbound Runtime Contract and inbound GPT reminder in `agent-skills/dsh-handoff.md` as their only textual source; the client must extract, not duplicate them.
- Never mutate a live DSH profile or publish to GitHub merely to test a source change.
