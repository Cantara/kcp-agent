# Governed Skill Library

A curated, reusable library of **governed KCP skills** — realistic playbooks an
autonomous agent would run, each declared as a `kind: skill` unit so the
`kcp-agent` planner gates it *before* it ever executes. This is both a starter
library you can copy and the fixture set for the defendable-agent demos.

A governed skill is an ordinary KCP unit plus three things:

- `kind: skill` — it is an invoke-eligible **procedure**, not a document.
- `action_scope { tools?, paths?, capabilities? }` — its declared **blast
  radius**. This is an *allow-list*: a tool/path not named here is not
  authorized. A skill fails closed, so **no `action_scope` = authorizes
  nothing.**
- `load_eligible: true` — the explicit **grant**. Without it, a well-formed,
  well-scoped skill is still inert (`skill_eligibility` gate).

Each `<skill>/SKILL.md` carries the human-facing playbook (YAML frontmatter
`name` + `description`, then a numbered procedure). `knowledge.yaml` is the
machine-facing manifest that declares all of them as governed units and is
signed with a detached ed25519 signature (`knowledge.yaml.sig`).

## The library

| Skill | `action_scope` (tools · paths · caps) | Audience | State | Gate / demo it exercises |
|---|---|---|---|---|
| **research-topic** | `Read,Grep,WebFetch,kcp_plan,kcp_load,kcp_memory_search,kcp_memory_remember` · `research/,docs/,knowledge/` | `agent,researcher` | current, granted, **read-only** | Bootstrap / read-only / grounding+memory showcase → the "Research Assistant" demo. Trips **nothing** — governance as an enabler. |
| **risk-assessment** | `Read,Grep` · `policies/,customers/` | `agent` | current, granted | The eligible skill that **loads**. Read-only; setting account status is out of scope (needs approval). |
| **docs-viewer** | `Read,Grep` · `docs/,skills/` | `agent,human` | current, granted | The clean in-scope template — tools it *may* touch = tools it *needs*. |
| **deploy** | `Read,Bash` · `config/` · `deploy:staging` | `agent` | current, granted | Conformance-violation target: `prod/` and `secrets/` are **absent** from the allow-list, so touching them is unauthorized. |
| **code-refactor** | `Read,Edit,Bash` · `src/,test/` · `test:run` | `agent` | current, granted | The "Overnight Refactor" skill — edits code, runs tests; **no `prod/`, no secrets, no push**. |
| **compliance-sweep** | `Read,Grep,Write` · `policies/,customers/,reports/` | `agent` | current, granted | Autonomous batch skill; only writable path is `reports/` — audits, never remediates. |
| **db-migration-signed** | `Read,Bash` · `migrations/` · `db:migrate` | `agent` | current, granted, **signed** | High-consequence skill whose provenance rides the manifest signature. |
| **db-migration-unsigned** | `Read,Bash` · `migrations/` · `db:migrate` | `agent` | **tampered variant** | Same content, served from `knowledge.tampered.yaml` → **signature** verification fails closed. |
| **risk-assessment-2024** | `Read,Grep` · `policies/,customers/` | `agent` | **superseded** by `risk-assessment` | **supersession** gate. |
| **poisoned-playbook** | `Read,Grep` · `customers/` | `untrusted` | hostile / out-of-audience | **audience** gate (first gate — skipped before it is even scored). |
| **no-scope-skill** | *(none)* | `agent` | granted but **unscoped** | **conformance** — `validate` errors: a load-eligible skill with no `action_scope` authorizes nothing. |
| **ungranted-skill** | `Bash` · `config/` · `secrets:rotate` | `agent` | well-scoped, **not granted** | **skill_eligibility** gate — no `load_eligible: true`. |

## Gate order

The planner evaluates gates in a fixed cascade and stops at the first rejection.
For governed skills the relevant ones are:

```
audience → not_for → temporal → deprecated → supersession → relevance
        → skill_eligibility → attestation → payment → access → strict
        → max_units → money_budget → context_budget
```

Signature verification runs *before* any of this, at manifest load: a manifest
that fails verification never reaches the planner.

---

## Proof — real CLI output

All output below is captured verbatim from this branch
(`node dist/cli.js …`, i.e. `kcp-agent`), against this manifest.

### 0. The bootstrap skill loads cleanly — governance as an enabler

The flagship read-only `research-topic` skill is an autonomous agent's safe
starting point: eligible, in-audience, current, and read-only, so it passes
every gate and **loads**. Nothing to trip — the gates clear the way.

Task: *"research our refund policy"*

```
$ kcp-agent plan "research our refund policy" --manifest examples/governed-skills/knowledge.yaml --trace

Load plan (3 units):
  ● 1. research-topic (score 9)  research-topic/SKILL.md  free
     Comprehensively research a topic: gather governed sources, cross-check, synthesize a grounded cited report, remember findings
     why: intent matches 1 term(s); triggers match 1 term(s); id/path matches 1 term(s)
  ● 2. compliance-sweep (score 4)  compliance-sweep/SKILL.md  free
  ● 3. docs-viewer (score 4)  docs-viewer/SKILL.md  free
```

`--json` for `research-topic`:

```
research-topic   selected   rejectedBy=None
  skill_eligibility  passed=true  :: kind: skill with explicit eligibility grant
```

### 1. Conformance — `validate` catches the unscoped skill (fail-closed)

```
$ kcp-agent validate examples/governed-skills/knowledge.yaml
Validate: examples/governed-skills/knowledge.yaml (governed-skill-library)
  ✗ unit 'no-scope-skill': kind: skill is load_eligible but declares no action_scope — a governed skill authorizes nothing until it lists the tools/paths/capabilities it may touch (fail-closed, #100)

✗ invalid — 1 error(s), 0 warning(s)
# exit 1
```

### 2. An eligible skill loads; superseded and out-of-audience are skipped with reasons

Task: *"assess the credit and compliance risk of a customer account from our policies"*

```
$ kcp-agent plan "assess the credit and compliance risk of a customer account from our policies" \
      --manifest examples/governed-skills/knowledge.yaml --trace

Load plan (2 units):
  ● 1. risk-assessment (score 48)  risk-assessment/SKILL.md  free
     why: intent matches 8 term(s); triggers match 5 term(s); id/path matches 2 term(s)
  ● 2. compliance-sweep (score 15)  compliance-sweep/SKILL.md  free

Skipped (10):
  · research-topic: no task-relevance match
  · docs-viewer: no task-relevance match
  · deploy: no task-relevance match
  · code-refactor: no task-relevance match
  · db-migration-signed: no task-relevance match
  · risk-assessment-2024: superseded by risk-assessment (successor active)
  · poisoned-playbook: audience ["untrusted"] excludes role 'agent'
  · no-scope-skill: no task-relevance match
  · ungranted-skill: no task-relevance match
  · db-migration-unsigned: no task-relevance match

● risk-assessment (score 48) risk-assessment/SKILL.md
  ✓ skill_eligibility kind: skill with explicit eligibility grant
```

The same run as JSON (`--json`), reduced to `outcome` / `rejectedBy` / reason:

```
risk-assessment       selected  rejectedBy=None
risk-assessment-2024  skipped   rejectedBy=supersession       superseded by risk-assessment (successor active)
poisoned-playbook     skipped   rejectedBy=audience           audience ["untrusted"] excludes role 'agent'
compliance-sweep      selected  rejectedBy=None
db-migration-signed   skipped   rejectedBy=relevance          no task-relevance match
...
```

### 3. The ungranted skill is skipped by `skill_eligibility` (strict)

Task: *"rotate the api credentials and secrets across services"* (matches
`ungranted-skill`'s triggers). Under `--strict` the soft gate becomes a
fail-closed skip:

```
$ kcp-agent plan "rotate the api credentials and secrets across services" \
      --manifest examples/governed-skills/knowledge.yaml --strict --trace --json
ungranted-skill   skipped   rejectedBy=skill_eligibility   :: kind: skill not invoke-eligible: no explicit eligibility grant
```

In non-strict mode the same unit soft-passes but is rendered `loadEligible=false`
(`○ ungranted-skill …`), so the agent still sees it is not cleared to run.

### 4. Signature — signed verifies, tampered fails closed

```
$ kcp-agent plan "assess customer credit risk" --manifest examples/governed-skills/knowledge.yaml
Signature: ✓ ed25519 signature verified (envelope key) · key governed-skills-2026

$ kcp-agent plan "apply database migration" --manifest examples/governed-skills/knowledge.tampered.yaml
kcp-agent: examples/governed-skills/knowledge.tampered.yaml: signature invalid: ed25519 signature does not match manifest bytes
# exit 1 — the poisoned manifest never reaches the planner
```

`knowledge.tampered.yaml` is a copy of the signed manifest with one extra unit
(`db-migration-unsigned-injected`, which also tries to reach `prod/`) appended
*after* signing. It still points at the original `knowledge.yaml.sig`, so its
bytes no longer match and verification fails before planning — exactly what
protects `db-migration-signed` from a spliced-in "also drop the audit table"
step.

---

## Reproduce

```bash
npm install && npm run build           # provides dist/cli.js (kcp-agent)

# validate (catches no-scope-skill)
node dist/cli.js validate examples/governed-skills/knowledge.yaml

# gate proofs
node dist/cli.js plan "assess the credit and compliance risk of a customer account from our policies" \
    --manifest examples/governed-skills/knowledge.yaml --trace
node dist/cli.js plan "rotate the api credentials and secrets across services" \
    --manifest examples/governed-skills/knowledge.yaml --strict --trace --json

# signature
node dist/cli.js plan "assess customer credit risk" --manifest examples/governed-skills/knowledge.yaml
node dist/cli.js plan "apply database migration"     --manifest examples/governed-skills/knowledge.tampered.yaml

# re-seal after editing knowledge.yaml
node scripts/seal-example.mjs examples/governed-skills/knowledge.yaml governed-skills-2026
```

## Notes on the model (known gaps)

- **Signing is manifest-level.** KCP signs the whole `knowledge.yaml` with one
  ed25519 signature, not per unit. The signed/unsigned "twin" is therefore
  demonstrated with a signed manifest and a tampered variant, not two
  independently-signed units.
- **`action_scope` is declarative at plan time.** The planner records and
  reasons about a skill's scope, and `validate` fail-closes an *empty* scope
  (`no-scope-skill`), but there is **no runtime conformance gate** that rejects a
  skill for *reaching outside* its declared scope (e.g. `deploy` touching
  `prod/`). That boundary is machine-checkable from the declaration; an enforcing
  executor is the natural next step. `deploy` and `code-refactor` are authored so
  that the "forbidden" paths are simply absent from their allow-lists.
