# Confidence-gate conformance vectors

The shared corpus for `assess()` — the confidence gate. Every implementation runs these and
must produce identical verdicts:

| Port | Runner |
|---|---|
| TypeScript (reference) | `test/assess-vectors.test.ts` |
| Java | `java/kcp-planner/src/test/.../conformance/AssessConformanceTest.java` |
| Rust | `rust/kcp-planner/tests/assess_conformance.rs` |

## Why these are in a subdirectory

All three planner harnesses list `vectors/*.json` **non-recursively**. A differently-shaped
vector sitting beside the planner vectors would be loaded as a planner vector and fail, so
these live one level down.

## Schema

```jsonc
{
  "name": "self-report-decimal",     // must match the filename stem
  "gate": "confidence",
  "spec": "§confidence-gate",
  "description": "…",                 // reads as the test name
  "task": "…",
  "answer": "…",                      // self-reports are extracted from this
  "units": [],
  "options": {                        // AssessOptions
    "threshold": 0.7,
    "asOf": "2026-07-28",             // pin it: an unpinned verdict stamps today
    "severity": "critical",           // optional
    "aggregate": "mean",              // optional, default "min"
    "includeSelfReport": false,       // optional, default true
    "selfReport": { "source": "self", "score": 0.5, "reasoning": "…" }  // optional
  },

  // Exactly one of these two, or neither:
  "evaluator":      { "score": 0.5, "reasoning": "…" },  // a fixed judge result
  "evaluatorError": "upstream timeout",                   // a judge that fails

  // Exactly one of:
  "expect": {
    "passed": false, "score": 0.5, "threshold": 0.7,
    "severity": "critical",                               // optional
    "signals": [{ "source": "self", "score": 0.9 }],      // order matters
    "detail": "confidence 0.5 < threshold 0.7 — …"
  },
  "expectError": "invalid threshold 1.5 — expected 0..1"
}
```

**The evaluator is supplied, not invoked.** In production it is an LLM call; here a vector
provides its *result*. These vectors pin the **adjudication of given signals**, never the
generation of them — the same line the grounding tests draw.

**`detail` is contract, not decoration.** It is what a human reads in an audit, so a port
that adjudicates identically but narrates differently is not conformant. Detail strings are
compared exactly.

## What the corpus covers

Self-report extraction (decimal, percent, last-wins, clamping), threshold boundary (`>=`, so
a score exactly on the line passes), `min` vs `mean` aggregation, and every fail-closed rule:
no signal obtainable, self-report out of range, evaluator out of range, evaluator throwing,
and an invalid threshold being refused rather than clamped.

Verified as a real gate rather than a decorative one — with the corpus green, five separate
mutations of the reference implementation were each caught:

| Mutation | Vectors that failed |
|---|---|
| `>=` → `>` on the threshold | 1 |
| `min` aggregation → `max` | 1 |
| percent normalisation dropped | 1 |
| clamping dropped | 1 |
| no-signal fail-closed removed | 2 |
| evaluator error no longer fails closed | 1 |

## Two representation differences, deliberately not forced

- **Rust models `score` as `Option<f64>`**; TypeScript and Java use `0` for "no score
  obtainable". Same adjudication, different encoding of the same fact — the Rust runner maps
  `None` to `0` for comparison and says so, rather than pretending the shapes match.
- **An invalid threshold** raises in all three, but the mechanism differs by language
  (`throw` / `IllegalArgumentException` / `Err`). The vectors pin the **message**, which is
  the part a caller sees.

## The open question, settled

#97 asked whether per-source thresholds (`{ self: 0.7, evaluator: 0.6 }`) should be in the
options shape before the vectors froze it. **They are not**, deliberately.

A single `threshold: number` is the restrictive choice, and a restrictive rule relaxes
compatibly: a future version can accept either a number or an object without invalidating a
single vector here. Freezing the per-source shape now would commit the protocol — in three
languages — to a distinction nobody has needed twice yet, and a permissive rule cannot be
narrowed later.

Adding it later costs one new vector. Removing it later costs a breaking change.
