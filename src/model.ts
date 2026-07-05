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
  /** Where the manifest was loaded from (path or URL) — set by the client. */
  source?: string;
}
