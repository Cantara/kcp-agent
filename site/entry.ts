// Browser entry for the gh-pages site — re-exports the deterministic half of
// the agent, unmodified. The site's arena runs THIS code (bundled by
// scripts/build-site.mjs), not a reimplementation: the same planner, the same
// term gate, the same formatter that ship in the CLI. test/site.test.ts proves
// the bundle plans identically to the source.

export { parseManifest } from "../src/client.js";
export { plan, DEFAULT_CAPABILITIES } from "../src/planner.js";
export type { AgentPlan, PlanOptions } from "../src/planner.js";
export { formatPlan } from "../src/format.js";
export { gateTerms } from "../src/loop.js";
