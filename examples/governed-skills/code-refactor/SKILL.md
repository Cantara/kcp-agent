---
name: code-refactor
description: Autonomously refactor application source for clarity and run the test suite to prove behavior is unchanged. Authorized for src/ and test/ and the test-run capability only. It never touches prod/ or secrets/ and never pushes — the human reviews the diff before anything leaves the working tree.
---

# Code Refactor (the "Overnight Refactor" skill)

**Purpose.** The canonical autonomous-agent skill: left running unattended, it
improves the shape of the code and proves it didn't break anything — inside a
box it cannot escape. This is what makes an overnight agent *defendable*: not
that you trust it, but that its `action_scope` makes the blast radius small and
declared.

**Declared blast radius.** `Read`, `Edit`, `Bash` over `src/` and `test/`,
capability `test:run`. **No `prod/`. No `secrets/`. No push** — `git push` is
not in the tool set, so the work stays in the working tree for a human to
review. The agent can change code and run tests; it cannot ship, exfiltrate, or
reach production.

## Steps

1. **Read the target module** under `src/`.
2. **Refactor** for clarity/duplication with `Edit`, staying inside `src/` and
   `test/`. Behavior must not change.
3. **Run the tests** (`Bash`, `test:run`). Green is the gate — a red suite
   means revert, not "adjust the test to pass".
4. **Leave the diff for review.** Do not push, tag, or deploy. Do not read
   `secrets/` or touch `prod/`. Summarize what changed and why.
