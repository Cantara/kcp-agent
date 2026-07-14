// kcp-agent — public API.
//
// A reference agent that consumes the Knowledge Context Protocol end-to-end.
// The deterministic planner is the core; LLM synthesis is an optional layer.

export * from "./model.js";
export { parseManifest, loadManifest, loadManifestText } from "./client.js";
export {
  guardedFetchText,
  guardedFetchTextFinal,
  isPrivateAddress,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type FetchGuard,
} from "./fetch.js";
export {
  checkServing,
  normalizeServingUrl,
  buildServingLinks,
  type ServingCheck,
  type ServingStatus,
  type ServingLinks,
} from "./serving.js";
export {
  plan,
  scoreUnit,
  unitTokens,
  DEFAULT_CAPABILITIES,
  type AgentCapabilities,
  type PlanOptions,
  type AgentPlan,
  type PlannedUnit,
  type SkippedUnit,
  type FederationPlan,
  type BudgetPlan,
  type ContextPlan,
  type PaymentPlan,
} from "./planner.js";
export { formatPlan, formatPlanTree, formatValidation, formatGrounded, formatGroundedReplay, formatTrace, formatDiff } from "./format.js";
export {
  replayGroundedAnswer,
  type GroundedReplayReport,
  type ClaimReplayCheck,
  type GapReplayCheck,
  type GroundedReplayOptions,
} from "./replayground.js";
export {
  groundingLoop,
  type GroundRoundFn,
  type GroundLoopStatus,
  type GroundLoopRound,
  type GroundLoopResult,
  type GroundLoopOptions,
} from "./groundloop.js";
export { planTree, plans, DEFAULT_MAX_NODES, type FollowOptions, type PlanNode, type NotFollowedRef } from "./follow.js";
export { verifyManifestText, resolveLocation, type SignatureResult, type SignatureStatus, type VerifyOptions } from "./verify.js";
export {
  toEntry,
  verifyEntry,
  inMemoryStore,
  fileStore,
  recall,
  type MemoryEntry,
  type MemoryKind,
  type MemoryStore,
  type Recalled,
  type RecallStatus,
  type RecallReplay,
  type RecallOptions,
} from "./memory.js";
export {
  reuse,
  type ReuseStatus,
  type ReuseRequest,
  type ReuseDecision,
  type ReuseOptions,
} from "./reuse.js";
export {
  dedupeLoaded,
  knownMap,
  type KnownUnits,
  type EmittedUnit,
  type UnchangedUnit,
  type DedupResult,
} from "./session.js";
export { validateManifest, validateLocation, type Finding, type ValidationReport } from "./validate.js";
export {
  trace,
  GATE_ORDER,
  type GateName,
  type GateVerdict,
  type UnitTrace,
  type DecisionTrace,
} from "./trace.js";
export {
  diffPlans,
  type PlanDiff,
  type UnitMove,
  type ScoreChange,
  type UnitPresence,
  type BudgetShift,
  type ReasonChange,
} from "./diff.js";
export { outcomeOf, runVector, type VectorOutcome, type ConformanceVector } from "./vectors.js";
export {
  resolveProvider,
  AnthropicProvider,
  OpenAICompatProvider,
  type SynthesisProvider,
  type Message,
  type CompletionOptions,
  type ResolveOptions,
} from "./provider.js";
export { synthesize, loadPlannedUnits, loadAnthropicSdk, buildSynthesisMessages, SYSTEM_PROMPT, type SynthesisOptions, type SynthesisResult, type LoadedUnit } from "./synthesize.js";
export {
  groundAnswer,
  splitClaims,
  makeClaudeVerifier,
  makeProviderVerifier,
  makeVerifier,
  DEFAULT_MAX_GAPS,
  type GroundUnit,
  type GroundedAnswer,
  type ClaimVerdict,
  type Gap,
  type GroundStatus,
  type Verifier,
  type GroundOptions,
} from "./ground.js";
export {
  runLoop,
  askLoop,
  gateTerms,
  digestPlans,
  claudeCritic,
  providerCritic,
  makeCritic,
  type LoopOptions,
  type LoopResult,
  type LoopRound,
  type Critic,
  type Critique,
  type CritiqueInput,
  type PlanDigest,
  type Convergence,
} from "./loop.js";
export { startServer, type ServeOptions } from "./serve.js";
export { runCycle, watchManifest, type WatchOptions, type WatchEvent, type WatchCycleResult } from "./watch.js";
export { initManifest, type InitOptions } from "./init.js";
export {
  discoverManifest,
  crawlSite,
  generateWebManifest,
  extractTitle,
  extractHeadings,
  extractLinks,
  parseRobotsTxt,
  isDisallowed,
  wellKnownPaths,
  slugify,
  type DiscoverResult,
  type CrawlOptions,
  type CrawlResult,
  type PageInfo,
  type GenOptions,
} from "./discover.js";
