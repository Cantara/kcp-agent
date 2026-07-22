---
name: deploy
description: Deploy a release to the staging environment by rendering config and running the approved deploy tooling. Authorized for config/ and the staging deploy capability only. It must never touch prod/ or secrets/ — those are outside its declared action_scope and require a separate, human-approved production skill.
---

# Deploy (the conformance-violation target)

**Purpose.** Ship a build to **staging**. This skill exists to demonstrate a
skill whose *declared* scope is deliberately narrower than what a careless
agent might try to do — the classic "it had the tools, so it reached for prod"
failure. Its `action_scope` authorizes `config/` + `Bash` + a `deploy:staging`
capability, and pointedly **not** `prod/` and **not** `secrets/`.

**Declared blast radius.** `Read`, `Bash` over `config/`, capability
`deploy:staging`. `prod/` and `secrets/` are absent from the allow-list, so
touching them is a conformance violation — an authorization the skill was never
granted. An enforcing runtime rejects the action; the point of the declaration
is that the boundary is *machine-checkable before the agent runs*, not a line
in a wiki.

## Steps

1. **Render staging config** from `config/` for the target release tag.
2. **Run the approved deploy tool** (`Bash`, `deploy:staging`) against staging.
3. **Verify** the staging health check.
4. **Stop at staging.** Promoting to `prod/` or reading `secrets/` is *not* in
   this skill's `action_scope`. Do not improvise a path to production — hand off
   to the human-approved production-deploy procedure.
