# Example plan: two truly independent workstreams

**Parent objective:** Improve a sample project's documentation and independently assess test coverage. This is a routing **example**, not an instruction to open two Sessions automatically.

## Workstream A: docs-review

**Goal:** Identify unclear setup steps in the existing README and propose a correction.

**Boundary:** Read-only review; do not edit files or change the installation environment.

**Acceptance:** A concise list of specific documentation gaps, with file/section references and proposed wording.

## Workstream B: tests-review

**Goal:** Assess the current unit-test coverage and identify important untested behavior.

**Boundary:** Read-only review; do not edit files or change dependencies.

**Acceptance:** A list of tested and untested behaviors with observed evidence, and a prioritized set of candidate test additions.

## Controller rules

- Both tasks can proceed in separate persistent Sessions only when neither depends on the other's unaccepted output.
- Both are read-only, so they do not compete over shared mutable files.
- Do not create extra Sessions to bypass an existing busy or locked Session.
- GPT Reviews each result independently, then decides on any implementation task.
- Any later shared-file edits are **not** parallelized without assigning a single integration owner.
