# Security

This is an experimental local agent-control integration. It has **not** received a formal security audit. Agent-generated commands can damage files, disclose credentials or cause unwanted side effects within the permissions available to the agent.

## Design boundaries

- The plugin binds only to allowed loopback addresses (default `127.0.0.1`); no LAN or public listener.
- Every API route, including health, requires a bearer token managed by DSH's own credential store.
- The client reads the local token at runtime. Do **not** copy it into task text, public logs, GitHub Issues or screenshots.
- Session status checks use read-only DSH services; a status read should not wake a cold Session.
- Sandbox modes are controlled by DSH's permission system. The client does **not** silently escalate after a failure.
- Remote Desktop Commander or any other computer connector has its **own** permissions and security considerations; this plugin does not constrain those tools.

## Before running

Use a disposable environment or a narrowly scoped workspace for untrusted tasks. Back up valuable files. Avoid giving an Agent unrestricted access to personal documents, production accounts or organizational systems. Inspect plugin source, config, and proposed high-impact actions.

## Never commit

Credentials, `~/.dsh` data, private Session logs, `endpoint.json` from a live machine, model keys, private project paths or proprietary business data.

## Reporting

Please use GitHub's private vulnerability reporting / Security Advisories when available. Do not include live secrets or identifiable user data in reports.

See also DeepSeek Harness upstream [Safety documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md).
