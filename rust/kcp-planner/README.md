# kcp-planner (Rust)

A Rust port of the deterministic core of [kcp-agent](https://github.com/Cantara/kcp-agent) — the
LLM-free KCP planner. Given a task and a `knowledge.yaml`, `plan()` produces an inspectable load
plan: which units to load and in what order, which to skip and exactly why, how sub-manifests are
selected across the federation, and what the whole thing costs. Pure — no I/O, no model, no clock
(the point-in-time is the injected `as_of`).

This is a *second implementation*. Its correctness is defined by the TypeScript reference and
pinned by the shared conformance vectors: two independent planners that agree on every vector
validate the **spec**, not just one codebase.

> Status: **Phases 1–4** of [epic #42](https://github.com/Cantara/kcp-agent/issues/42) — the
> core planner, the conformance runner, the decision trace, and the plan diff. The CLI, WASM,
> network/MCP, and the release pipeline are later phases.

## Use

```rust
use kcp_planner::{parse_manifest, plan, PlanOptions};

let manifest = parse_manifest(yaml, Some("knowledge.yaml"))?;
let agent_plan = plan(&manifest, "how do I deploy?", &PlanOptions::default());
for u in &agent_plan.selected {
    println!("{} (score {}) eligible={}", u.id, u.score, u.load_eligible);
}
```

## The 13-gate cascade

Each unit runs an ordered cascade; it is skipped at the **first** gate it fails, with the exact
reason string the TypeScript reference emits (the "every decision is a sentence" contract is part
of the spec):

1. audience · 2. not_for · 3. temporal · 4. deprecated · 5. supersession precedence ·
6. relevance (score 0) · 7. attestation · 8. payment · 9. access · 10. strict ·
then, greedily by score: 11. max_units · 12. money budget · 13. context budget.

## Conformance

```bash
cargo test        # runs the conformance harness against ../../vectors/*.json
```

`tests/conformance.rs` loads every vector, runs it through the planner, and deep-equals the
outcome against `expect`. All 11 vectors pass; a new vector added to the shared corpus fails here
until this implementation handles it. Skip reasons, scores, budget arithmetic (6-decimal
rounding to match `Number.toFixed(6)`), and federation decisions must all match exactly.

The **decision trace** (`trace()`) and **plan diff** (`diff_plans()`) are validated the same way:
`fixtures/trace/*.json` and `fixtures/diff/*.json` are golden outputs generated from the
TypeScript reference (`npm run gen:rust-fixtures`), and `tests/{trace,diff}_conformance.rs`
reproduce them byte-for-byte — including every per-gate detail string.

## Design notes

- **Deterministic.** No clock, no randomness, no map-iteration-order dependence. `as_of` is the
  only source of "now"; the same `(manifest, task, options)` always yields the same plan.
- **Fail-closed.** Every gate defaults to deny; a unit is load-eligible only after passing all of
  them, and non-eligible units are surfaced (not silently dropped) unless `strict`.
- **Numbers.** Money uses 6-decimal rounding; token arithmetic is integer with thousands
  separators in the skip reasons, matching the reference's `toLocaleString("en-US")`.

Apache-2.0 · part of [Cantara/kcp-agent](https://github.com/Cantara/kcp-agent).
