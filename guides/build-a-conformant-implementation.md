# Build a conformant KCP planner

The deterministic planner is a **pure function**: `(manifest, task, options) → plan`. That makes it
portable — and worth porting. A second independent implementation is the strongest possible proof
the protocol is unambiguous (two implementations that agree on every decision validate the *spec*,
not just one codebase), and a Go/Rust port compiles to a **2–5 MB static binary** instead of the
176–244 MB Deno-bundled native (which embeds a JS runtime). This guide is how you build one and
prove it correct against the shared [conformance vectors](../vectors/).

The reference implementation in this repo is normative: [`src/planner.ts`](../src/planner.ts) (the
core), [`src/client.ts`](../src/client.ts) (manifest parsing), and [`src/vectors.ts`](../src/vectors.ts)
(the outcome shape). When this guide and the code disagree, the code wins — and a vector should be
added to pin it.

## 1. The contract

Your implementation parses a `knowledge.yaml` and, for a task + a set of capabilities, emits a
plan: which units to **load**, in what order, which to **skip** and *why*, plus the federation,
budget, and trust decisions. No content is fetched and no model is called — planning is metadata
only (**audit before action**). The portable projection every implementation must reproduce is
[`VectorOutcome`](../vectors/README.md#expect--the-normalized-outcome).

Two properties are non-negotiable:

- **Determinism.** Same inputs → byte-identical outcome. No clocks (the point-in-time is the
  explicit `asOf` input), no randomness, no map-iteration-order dependence.
- **Fail-closed.** Every gate defaults to *deny*. A unit is load-eligible only when it passes every
  gate; when in doubt, it is skipped or marked not-eligible with a written reason.

## 2. The pipeline, in order

For each unit in **manifest order**, run these gates. The **first** one that fails skips the unit
with that exact reason string (the strings are part of the contract — a consumer reads them):

1. **Audience** — if `audience` is non-empty and does not include the agent's `role`:
   `audience ["human"] excludes role 'agent'`.
2. **Negative space (`not_for`)** — if any `not_for` phrase contains a task term:
   `not_for declares it does not serve '<phrase>'`.
3. **Temporal** (evaluated at `asOf`, UTC): before `valid_from` → `not active until <date>`; after
   `valid_until` → `expired <date> (superseded by <id>)` (the parenthetical only if declared);
   `deprecated: true` → `deprecated`.
4. **Supersession precedence** — even inside a validity overlap, if the unit's declared
   `superseded_by` successor is itself selectable at `asOf`, skip the predecessor:
   `superseded by <id> (successor active)` (spec §4.22).
5. **Relevance** — score the unit (see §3); score 0 → `no task-relevance match`.

A unit that survives all five is **selected**, then evaluated for **load-eligibility** (it stays in
the plan either way, so the caller sees the gate; `--strict` drops non-eligible units instead).
Eligibility is reduced by, in order, appending a reason each time:

6. **Skill eligibility** (v0.16.0, spec §4.3a `kind: skill`) — a governed procedure/skill fails
   closed by default: not eligible unless the unit carries an explicit `load_eligible: true` grant,
   `kind: skill not invoke-eligible: no explicit eligibility grant`. This is a **soft gate outside
   `--strict`** — the plan still lists the unit with `loadEligible: false` so the caller can see it
   was evaluated — but under `--strict` it fail-closes at this gate specifically, so the skip is
   attributed to `skill_eligibility` rather than the generic strict gate. Units that are not
   `kind: skill` pass through untouched (`not a skill`).
7. **Attestation** — if the manifest requires attestation and the unit is `access: restricted` and
   the agent cannot present a trusted provider: not eligible, `restricted: requires attestation the
   agent cannot present`.
8. **Payment affordability** — if the unit's payment method is not one the agent can settle: not
   eligible, `unaffordable: <method>`.
9. **Access is the auth axis** — `authenticated`/`restricted` with **no credentials**: append
   `access '<level>': agent holds no credentials`; `restricted` → not eligible. Payment **never**
   substitutes for identity: a `restricted` + `x402` unit also emits the §4.11 mis-authoring hint.
   (An anonymous-paid unit is declared `access: public` with a payment block, so it never reaches
   this gate.)

## 3. Scoring

Tokenize the task and each unit's `intent`, `triggers`, and `id`+`path` with the **same** tokenizer:
lowercase, split on any non-letter/digit (Unicode-aware), drop tokens ≤ 2 chars and a small stopword
set (see `terms()` in `planner.ts`). Then:

```
score = 3 × (task terms found in intent)
      + 4 × (task terms found in triggers)   // triggers match either direction: term⊂trigger or trigger⊂term
      + 2 × (task terms found in id+path)
```

## 4. Selection order and the ceilings

Sort survivors by **score descending, then `id` ascending** (the tie-break makes order total and
deterministic). Then walk them greedily, taking each if it fits, keeping walking if it doesn't — a
smaller/cheaper lower-scored unit still gets its chance. **Not** a knapsack optimizer; simple and
explainable:

- **`maxUnits`** — stop selecting past the cap (default 5); note the overflow in `warnings`.
- **Money `budget`** — only load-eligible, priced units spend. Different currency →
  `over budget: costs <c>, budget is in <cur>`. Would exceed → `over budget: <price> would exceed
  remaining <r> of <ceiling> <cur>`. The ceiling is **tree-wide** across a federated walk, not
  per-manifest.
- **Context `contextBudget`** — token ceiling, same greedy shape. Size is the declared `size_tokens`,
  else `ceil(bytes / 4)` (an estimate), else *unmeasured* (admitted + warned, or excluded under
  `strict`). Over → `over context budget: <n> tokens would exceed remaining <r> of <ceiling>`
  (numbers are thousands-separated: `1,240`). A unit must fit **both** ceilings.

## 5. Validate your port against the corpus

Each file in [`vectors/`](../vectors/) is a self-contained `(manifest-as-YAML, task, options) →
expect` fixture. The conformance test is one loop:

```
for each vector v in vectors/*.json:
    manifest = parse_yaml(v.manifest)
    plan     = your_planner(manifest, v.task, v.options)
    outcome  = normalize(plan)          // the VectorOutcome projection
    assert outcome == v.expect          // deep, ordered equality
```

The reference harness is [`test/vectors.test.ts`](../test/vectors.test.ts); the outcome shape and
field-by-field meaning are in [`vectors/README.md`](../vectors/README.md). Start with
`scoring-relevance` and `access-restricted-gated`, then work outward — when all 11 pass, you agree
with the reference on scoring, every gate, temporal precedence, federation slicing, and both budgets.

**Gotchas that trip a first port**

- The skip/eligibility **reason strings are verbatim contract**, punctuation and all. Reproduce them
  exactly, or emit your own and let consumers lose the shared vocabulary.
- The tokenizer must match, including the bidirectional trigger match and the stopword list — most
  early mismatches are scoring, not gating.
- `asOf` is the *only* source of "now". Never read the system clock inside the planner.
- Order matters in every array; sort exactly as in §4.

## 6. Scope of a minimal port

The deterministic core is three pieces: manifest **parsing** (`client.ts`), the **planner**
(`planner.ts`), and `validate` (`validate.ts`). Signature verification, the LLM synthesis layer,
episodic memory, and the MCP server are all *optional* additions on top — a conformant *planner*
needs only the three. That is the well-bounded surface the vectors define.

## Upstream

The corpus is proposed to
[`knowledge-context-protocol`](https://github.com/Cantara/knowledge-context-protocol) as the
normative conformance suite. Add a vector (extend `scripts/gen-vectors.mjs`, `npm run gen:vectors`,
review the diff) whenever you find behavior the corpus doesn't yet pin — a gap in the vectors is a
gap in the spec's testability.
