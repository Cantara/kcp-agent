// kcp-agent — public API.
//
// A reference agent that consumes the Knowledge Context Protocol end-to-end.
// The deterministic planner is the core; LLM synthesis is an optional layer.

export * from "./model.js";
export { parseManifest, loadManifest, loadManifestText } from "./client.js";
export {
  guardedFetchText,
  isPrivateAddress,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type FetchGuard,
} from "./fetch.js";
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
export { formatPlan, formatPlanTree, formatValidation, formatGrounded } from "./format.js";
export {
  groundAnswer,
  splitClaims,
  makeClaudeVerifier,
  DEFAULT_MAX_GAPS,
  type GroundUnit,
  type GroundedAnswer,
  type ClaimVerdict,
  type Gap,
  type GroundStatus,
  type Verifier,
  type GroundOptions,
} from "./ground.js";
export { planTree, plans, DEFAULT_MAX_NODES, type FollowOptions, type PlanNode, type NotFollowedRef } from "./follow.js";
export { verifyManifestText, resolveLocation, type SignatureResult, type SignatureStatus, type VerifyOptions } from "./verify.js";
export { validateManifest, validateLocation, type Finding, type ValidationReport } from "./validate.js";
export { synthesize, loadPlannedUnits, loadAnthropicSdk, type SynthesisOptions, type SynthesisResult, type LoadedUnit } from "./synthesize.js";
export {
  runLoop,
  askLoop,
  gateTerms,
  digestPlans,
  claudeCritic,
  type LoopOptions,
  type LoopResult,
  type LoopRound,
  type Critic,
  type Critique,
  type CritiqueInput,
  type PlanDigest,
  type Convergence,
} from "./loop.js";
