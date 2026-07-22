---
name: no-scope-skill
description: DEMONSTRATION of a mis-authored governed skill — kind skill and load_eligible true, but with NO action_scope. A skill fails closed, so a skill with no declared scope authorizes nothing. validate flags it as an error before it can ever ship.
---

# No-Scope Skill (fail-closed conformance)

**Purpose.** Show what happens when a publisher grants a skill invoke
eligibility but forgets to declare *what it is allowed to touch*. A governed
skill's `action_scope` is the **only** thing that authorizes a tool or path — so
a skill with no `action_scope` authorizes **nothing**. It is not "unrestricted";
it is inert, and shipping it is a publisher error.

**Status.** `kind: skill`, `load_eligible: true`, no `action_scope`. The
`validate` conformance check flags it as an **error** (`authorizes nothing …
fail-closed`), so it is caught at publish time rather than handing an autonomous
agent a runnable procedure with an undeclared blast radius.

## The lesson

- A skill without `action_scope` is the fail-closed default made visible: **no
  declaration, no authorization.** Fix it by declaring the minimal `tools` /
  `paths` / `capabilities` the procedure actually needs — see `docs-viewer` for
  the clean shape.
