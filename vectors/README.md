# KCP conformance vectors

A corpus of `(manifest, task, options) → expected outcome` fixtures that freeze the
deterministic planner's behavior **as data**. They exist so that *any* implementation of the KCP
core — this TypeScript reference, a future Go/Rust port, or a third party's — can prove it is
conformant by reproducing every vector exactly.

Two independent implementations that pass the same vectors validate the **spec**, not just the
code: agreement on every decision is the strongest possible proof the protocol is unambiguous.

## Format

Each `*.json` file is one vector:

```jsonc
{
  "name": "budget-greedy-skip",          // == filename (stable, addressable)
  "spec": "§4.14",                        // the spec layer exercised
  "description": "…",                     // one line, human-readable
  "manifest": "kcp_version: \"0.25\"\n…", // the manifest as RAW YAML — you parse it yourself
  "task": "sovereign compute award",      // the query
  "options": {                            // planner inputs (see PlanOptions)
    "asOf": "2026-07-06",
    "capabilities": { "role": "agent", "paymentMethods": ["free", "x402"] },
    "budget": { "amount": 0.25 }
  },
  "expect": { … }                         // the outcome a conformant planner must reproduce
}
```

### `options`

Mirrors the library's `PlanOptions`: `env`, `asOf` (ISO date), `maxUnits`, `strict`, `budget`
(`{amount, currency?}`), `contextBudget`, and `capabilities` (`role`, `paymentMethods`,
`credentials`, `attestationProvider`). Omitted fields take their defaults (`role: "agent"`,
`paymentMethods: ["free"]`, today's date, etc.).

### `expect` — the normalized outcome

A portable projection of the full plan. **Order is significant** in the arrays.

| Field | Meaning |
|-------|---------|
| `selected[]` | `{ id, loadEligible, score }`, in load-plan order (by score, then id) |
| `skipped[]` | `{ id, reason }` — the reason string is part of the contract (every decision is a sentence) |
| `federation[]` | `{ id, selected, reason, credentialNeeded? }` per sub-manifest ref |
| `trust` | `{ requiresAttestation, agentCanAttest }` |
| `budget` | `{ rateTier, ceiling?, projectedSpend?, remaining?, currency? }` |
| `context` | `{ ceiling?, projectedTokens?, remaining?, approximate, unmeasured }` |
| `warnings[]` | non-fatal planner notes |

The exact shape is `VectorOutcome` in [`src/vectors.ts`](../src/vectors.ts); `outcomeOf(plan)`
produces it from a full `AgentPlan`.

## Running them

`test/vectors.test.ts` asserts the reference planner reproduces every vector
(`runVector(v)` deep-equals `v.expect`). A second implementation should do the same against this
directory.

## Regenerating

The corpus is generated *from* the reference planner, so the expected outcomes are never
hand-written:

```bash
npm run build && npm run gen:vectors     # writes vectors/*.json
```

Regenerate only when the planner changes **intentionally**, and review the diff — an unexpected
change to a vector is a regression the test would otherwise catch. Add a new vector by extending
the `inputs` array in [`scripts/gen-vectors.mjs`](../scripts/gen-vectors.mjs).

## Upstream

Proposed to [`knowledge-context-protocol`](https://github.com/Cantara/knowledge-context-protocol)
as the normative conformance suite any KCP planner implementation must pass.
