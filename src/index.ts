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
export { formatPlan, formatPlanTree, formatValidation } from "./format.js";
export { planTree, plans, type FollowOptions, type PlanNode, type NotFollowedRef } from "./follow.js";
export { verifyManifestText, resolveLocation, type SignatureResult, type SignatureStatus, type VerifyOptions } from "./verify.js";
export { validateManifest, validateLocation, type Finding, type ValidationReport } from "./validate.js";
export { synthesize, loadPlannedUnits, type SynthesisOptions, type SynthesisResult, type LoadedUnit } from "./synthesize.js";
