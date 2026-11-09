# Contributing

Thanks for improving gpt-dsh-bridge.

## Scope

Please keep changes focused on the native DSH Web control plugin, its thin client, the GPT handoff SOP, tests, and documentation. This project does not intend to build a new agent runtime or custom Session persistence layer.

## Development

- Node.js 20+ and PowerShell 5.1/7 are used for local tests.
- From `dsh-orchestrator/` run the unit tests:

```powershell
$tests = @(Get-ChildItem .\test -Filter 'unit-*.mjs' -File | ForEach-Object FullName)
node --test $tests
```

- If you change API / Session routing or token handling, add targeted regression tests.
- Do not bypass the DSH compatibility gate to hide untested versions.
- Preserve native Workspace ownership, explicit sandbox modes and loopback-only authentication.
- Update `README.md`, `README.zh-CN.md` and relevant Skills when behavior changes.

## Privacy and licensing

Do not submit credentials, account IDs, internal projects, local personal paths or proprietary business data. Verify ownership and license compatibility for all contributed source. Use GitHub's private vulnerability reporting, where available, for security issues.
