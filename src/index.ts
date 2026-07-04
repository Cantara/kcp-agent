// @cantara/kcp-agent — public API.
//
// A reference agent that consumes the Knowledge Context Protocol end-to-end.
// The deterministic planner is the core; LLM synthesis is an optional layer.

export * from "./model.js";
export { parseManifest, loadManifest, loadManifestText } from "./client.js";
export {
  plan,
  scoreUnit,
  DEFAULT_CAPABILITIES,
  type AgentCapabilities,
  type PlanOptions,
  type AgentPlan,
  type PlannedUnit,
  type SkippedUnit,
  type FederationPlan,
  type BudgetPlan,
  type PaymentPlan,
} from "./planner.js";
