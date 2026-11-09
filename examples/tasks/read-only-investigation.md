# Task card: read-only diagnosis

**Workstream:** diagnostic-investigation (reuse the existing Session if present).

**Goal:** Determine why the current local Node.js test suite fails or intermittently fails, and identify the smallest testable root-cause hypothesis.

**Context:** The target project root and test command are supplied by the user. Inspect only that authorized project and relevant local diagnostic output.

**Boundaries:**
- Do not modify files, dependencies, configurations, credentials or runtime permissions.
- Do not access unrelated folders or external accounts.
- Choose your own diagnostic commands inside the read-only scope.
- If the root cause requires a write, first report the candidate fix and request a separate authorized change task.

**Acceptance:** Provide the failing test name, observed output, likely cause with evidence, and a recommended next step. Distinguish observed facts from hypotheses.

**Evidence:** Include actual test command and exit code, file paths/symbols relevant to the issue, and any unverified assumptions.
