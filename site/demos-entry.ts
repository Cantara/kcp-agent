// Browser entry for the playground's LLM-adjacent demos — the parts that are NOT
// the deterministic planner and so don't come from the WASM module. `gateTerms`
// (the loop's term gate) and `groundAnswer` (claim grounding) ship here,
// unmodified from the CLI source. The planner itself — plan/trace/diff/validate —
// runs as WebAssembly (docs/pkg), the same Rust core the CLI binary runs.

export { gateTerms } from "../src/loop.js";
export { groundAnswer, splitClaims } from "../src/ground.js";
export type { GroundUnit, GroundedAnswer, Verifier } from "../src/ground.js";
