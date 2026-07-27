// A compact KCP model — the subset of the knowledge.yaml schema the agent's
// planner reasons about. The Knowledge Context Protocol spec is the source of
// truth; this mirrors the fields the reference agent consumes end-to-end
// (navigation, trust, temporal, federation, economics).

export interface PaymentMethod {
  type: string; // free | x402 | meter | subscription
  currency?: string;
  price_per_request?: string;
  networks?: string[];
  wallet?: string;
  provider?: string;
  plans_url?: string;
  free_tier?: boolean;
  free_requests_per_day?: number;
  upgrade_url?: string;
}

export interface Payment {
  default_tier?: string;
  methods?: PaymentMethod[];
  billing_contact?: string;
}

export interface RateLimitTier {
  requests_per_minute?: number | "unlimited";
  requests_per_hour?: number | "unlimited";
  requests_per_day?: number | "unlimited";
}

export interface RateLimits {
  default?: RateLimitTier;
  authenticated?: RateLimitTier;
  premium?: RateLimitTier;
  backoff?: string;
}

export interface Temporal {
  valid_from?: string;
  valid_until?: string;
  superseded_by?: string;
}

export interface AgentIdentity {
  required?: boolean;
  credential_hint?: string;
  issuer_hint?: string;
  docs_url?: string;
}

export interface ManifestRef {
  id: string;
  url: string;
  label?: string;
  relationship?: string;
  context?: string[];
  agent_identity?: AgentIdentity;
}

export interface Unit {
  id: string;
  path: string;
  intent: string;
  scope?: string;
  audience: string[];
  triggers: string[];
  access?: string; // public | authenticated | restricted
  auth_scope?: string;
  deprecated?: boolean;
  not_for?: string[];
  payment?: Payment;
  rate_limits?: RateLimits;
  temporal?: Temporal;
  /** Unit classification — e.g. "skill" for a procedure governed as an invoke-eligible unit (#100). */
  kind?: string;
  /**
   * Declared action scope for a governed procedure/skill — the tools, paths, and
   * capabilities it is permitted to touch when invoked (#100).
   */
  action_scope?: {
    tools?: string[];
    paths?: string[];
    capabilities?: string[];
    spend?: { max_spend?: number; allowed_vendors?: string[]; currency?: string };
  };
  /**
   * Ordered composition a `kind: playbook` declares — §4.3b (v0.29, RFC-0027).
   *
   * The step, not the playbook, is the unit of governance: `authority_level` is a
   * ceiling on one step, and effective authority is the minimum across it, the
   * playbook's, the task-type grant_ceiling, any tenant ceiling, and the enacting
   * agent's grant. A playbook can therefore never raise authority.
   *
   * Absent means "declares no steps", which is distinct from an empty composition and
   * fails closed at the eligibility gate (#118).
   */
  steps?: PlaybookStep[];
  /**
   * Explicit eligibility grant for a skill or playbook. Both fail closed by default;
   * only a unit with `load_eligible: true` is load/invoke-eligible (#100, #118).
   */
  load_eligible?: boolean;
  /** Declared token cost — the faithful input for context-window budgeting (#33). */
  size_tokens?: number;
  /** Declared byte size — the estimate source when size_tokens is absent (tokens ≈ bytes/4). */
  bytes?: number;
}

/**
 * One step of a `kind: playbook` composition — §4.3b (v0.29, RFC-0027).
 *
 * `uses` is a reference to another unit rather than prose, which is the whole point:
 * a checker can resolve it, confirm the target is `kind: skill`, and compare the
 * declared authority against that unit's action_scope. Prose steps cannot be checked.
 */
export interface PlaybookStep {
  /** Unique within the playbook. */
  id: string;
  /** Unit id this step enacts; SHOULD name a `kind: skill` unit. */
  uses?: string;
  /** Inline description, when no unit exists yet. Scope-unbounded — see §4.3b. */
  action?: string;
  /** Step ids that must complete successfully first. The graph MUST be acyclic. */
  depends_on?: string[];
  /** RFC-0025 scale. Ceiling semantics: at most this level. */
  authority_level?: string;
  /** RFC-0026 triggers, evaluated before enactment. Disjunctive; always a list here. */
  escalation?: string[];
  /** Prose assertion. The protocol defines no evaluation mechanism. */
  success_condition?: string;
  /** `abort` | `continue` | `escalate`. Default `abort`. */
  on_failure?: string;
  /** ISO 8601 duration; elapsing constitutes failure. */
  timeout?: string;
}

export interface Signing {
  scheme?: string; // e.g. ed25519
  scope?: string; // e.g. this-manifest
  /** URL of (or inline) public key material. */
  public_key?: string;
  /** URL of (or inline base64) detached signature over the manifest bytes. */
  signature?: string;
  /** Publisher's key identifier, when the manifest declares one (KCP ≤0.20 trust.content_integrity). */
  key_id?: string;
}

/** Serving Endpoint Binding (§3.12, KCP 0.26) — where this manifest is authoritatively served. */
export interface Serving {
  /** Exhaustive list of HTTPS URLs the manifest is authoritatively served from. */
  manifest?: string[];
  /** Exhaustive list of HTTPS MCP endpoints authorized to represent this manifest. */
  mcp?: string[];
}

export interface TrustAgentRequirements {
  require_attestation?: boolean;
  trusted_providers?: string[];
  attestation_url?: string;
}

export interface Manifest {
  project: string;
  version: string;
  kcp_version?: string;
  units: Unit[];
  manifests: ManifestRef[];
  payment?: Payment;
  rate_limits?: RateLimits;
  trust?: { agent_requirements?: TrustAgentRequirements };
  signing?: Signing;
  serving?: Serving;
  /** Where the manifest was loaded from (path, or final post-redirect URL) — set by the client. */
  source?: string;
}
