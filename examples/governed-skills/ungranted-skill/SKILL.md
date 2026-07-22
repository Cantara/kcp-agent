---
name: ungranted-skill
description: DEMONSTRATION of a governed skill that is well-formed and in-scope but was never granted invoke eligibility — kind skill with no load_eligible true. Skills fail closed, so the skill_eligibility gate skips it. Rotating credentials is exactly the kind of action that should require an explicit grant.
---

# Ungranted Skill (the skill_eligibility gate)

**Purpose.** A perfectly reasonable, correctly-scoped skill — rotate API
credentials across services — that simply has **not been granted** invoke
eligibility. It proves that declaring a good `action_scope` is *necessary but
not sufficient*: a governed skill is inert until someone explicitly turns it on
with `load_eligible: true`.

**Status.** `kind: skill` with a valid `action_scope` but **no**
`load_eligible: true`. Under `--strict`, the **skill_eligibility gate** skips it
fail-closed — `rejectedBy: skill_eligibility`, reason *"kind: skill not
invoke-eligible: no explicit eligibility grant"*. In non-strict mode it
soft-passes but is marked `loadEligible=false`, so an agent still sees it is not
cleared to run.

## Steps (unreachable until granted)

1. The plan surfaces this skill but marks it not invoke-eligible.
2. To enable: a human sets `load_eligible: true` after reviewing the scope.
3. Only then would credential rotation (`Bash`, `secrets:rotate`, over
   `config/`) actually run.
