// KCP client — locate and load a knowledge.yaml into the compact model.
//
// A manifest may come from a local path, a directory (we look for
// knowledge.yaml or /.well-known/knowledge.yaml), or an HTTPS URL. The client
// only *reads* the manifest; the planner decides what to trust and load.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { guardedFetchTextFinal, type FetchGuard } from "./fetch.js";
import type { Manifest, Unit, ManifestRef, Payment, PaymentMethod, RateLimits, RateLimitTier, Signing, Serving } from "./model.js";

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const asStr = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));
const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const asNum = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
};

function normCount(v: unknown): number | "unlimited" | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "unlimited") return "unlimited";
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function parseTier(v: unknown): RateLimitTier | undefined {
  if (!isObj(v)) return undefined;
  return {
    requests_per_minute: normCount(v["requests_per_minute"]),
    requests_per_hour: normCount(v["requests_per_hour"]),
    requests_per_day: normCount(v["requests_per_day"]),
  };
}

function parseRateLimits(v: unknown): RateLimits | undefined {
  if (!isObj(v)) return undefined;
  return {
    default: parseTier(v["default"]),
    authenticated: parseTier(v["authenticated"]),
    premium: parseTier(v["premium"]),
    backoff: asStr(v["backoff"]),
  };
}

function parsePaymentMethod(v: unknown): PaymentMethod {
  const d = isObj(v) ? v : {};
  return {
    type: String(d["type"] ?? ""),
    currency: asStr(d["currency"]),
    price_per_request: asStr(d["price_per_request"]),
    networks: Array.isArray(d["networks"]) ? d["networks"].map(String) : undefined,
    wallet: asStr(d["wallet"]),
    provider: asStr(d["provider"]),
    plans_url: asStr(d["plans_url"]),
    free_tier: d["free_tier"] === undefined ? undefined : Boolean(d["free_tier"]),
    free_requests_per_day: d["free_requests_per_day"] === undefined ? undefined : Number(d["free_requests_per_day"]),
    upgrade_url: asStr(d["upgrade_url"]),
  };
}

function parsePayment(v: unknown): Payment | undefined {
  if (!isObj(v)) return undefined;
  return {
    default_tier: asStr(v["default_tier"]),
    methods: Array.isArray(v["methods"]) ? v["methods"].map(parsePaymentMethod) : undefined,
    billing_contact: asStr(v["billing_contact"]),
  };
}

function parseUnit(v: Raw): Unit {
  return {
    id: String(v["id"] ?? ""),
    path: String(v["path"] ?? ""),
    intent: String(v["intent"] ?? ""),
    scope: asStr(v["scope"]),
    audience: asStrArr(v["audience"]),
    triggers: asStrArr(v["triggers"]),
    access: asStr(v["access"]),
    auth_scope: asStr(v["auth_scope"]),
    deprecated: v["deprecated"] === undefined ? undefined : Boolean(v["deprecated"]),
    not_for: asStrArr(v["not_for"]),
    payment: parsePayment(v["payment"]),
    rate_limits: parseRateLimits(v["rate_limits"]),
    size_tokens: asNum(v["size_tokens"]),
    bytes: asNum(v["bytes"]),
    temporal: isObj(v["temporal"])
      ? {
          valid_from: asStr(v["temporal"]["valid_from"]),
          valid_until: asStr(v["temporal"]["valid_until"]),
          superseded_by: asStr(v["temporal"]["superseded_by"]),
        }
      : undefined,
  };
}

function parseManifestRef(v: Raw): ManifestRef {
  const ai = isObj(v["agent_identity"]) ? v["agent_identity"] : undefined;
  return {
    id: String(v["id"] ?? ""),
    url: String(v["url"] ?? ""),
    label: asStr(v["label"]),
    relationship: asStr(v["relationship"]),
    context: Array.isArray(v["context"]) ? v["context"].map(String) : undefined,
    agent_identity: ai
      ? {
          required: ai["required"] === undefined ? undefined : Boolean(ai["required"]),
          credential_hint: asStr(ai["credential_hint"]),
          issuer_hint: asStr(ai["issuer_hint"]),
          docs_url: asStr(ai["docs_url"]),
        }
      : undefined,
  };
}

/** Parse a YAML string into the compact Manifest model. */
export function parseManifest(text: string, source?: string): Manifest {
  const raw = yaml.load(text);
  if (!isObj(raw)) throw new Error("manifest is not a YAML mapping");
  const trustRaw = isObj(raw["trust"]) ? raw["trust"] : undefined;
  const signingRaw = isObj(raw["signing"]) ? raw["signing"] : undefined;
  let signing: Signing | undefined = signingRaw
    ? {
        scheme: asStr(signingRaw["scheme"]),
        scope: asStr(signingRaw["scope"]),
        public_key: asStr(signingRaw["public_key"]),
        signature: asStr(signingRaw["signature"]),
        key_id: asStr(signingRaw["key_id"]),
      }
    : undefined;
  // KCP ≤0.20 declared signing under trust.content_integrity with
  // {signing: {algorithm, key_id, public_key}, signature_file}. Map it so a
  // newer agent verifies old manifests instead of silently downgrading trust
  // to "unsigned" — version skew must never fail open.
  const ciRaw = trustRaw && isObj(trustRaw["content_integrity"]) ? trustRaw["content_integrity"] : undefined;
  const ciSigningRaw = ciRaw && isObj(ciRaw["signing"]) ? ciRaw["signing"] : undefined;
  if (!signing && ciRaw && ciSigningRaw) {
    signing = {
      scheme: asStr(ciSigningRaw["algorithm"]) ?? asStr(ciSigningRaw["scheme"]),
      public_key: asStr(ciSigningRaw["public_key"]),
      signature: asStr(ciRaw["signature_file"]) ?? asStr(ciSigningRaw["signature"]),
      key_id: asStr(ciSigningRaw["key_id"]),
    };
  }
  const ar = trustRaw && isObj(trustRaw["agent_requirements"]) ? trustRaw["agent_requirements"] : undefined;
  // Serving Endpoint Binding (§3.12, KCP 0.26) — exhaustive lists of where the
  // manifest is authoritatively served and which MCP endpoints represent it.
  const servingRaw = isObj(raw["serving"]) ? raw["serving"] : undefined;
  const serving: Serving | undefined = servingRaw
    ? {
        manifest: Array.isArray(servingRaw["manifest"]) ? servingRaw["manifest"].map(String) : undefined,
        mcp: Array.isArray(servingRaw["mcp"]) ? servingRaw["mcp"].map(String) : undefined,
      }
    : undefined;
  return {
    project: String(raw["project"] ?? "(unnamed)"),
    version: String(raw["version"] ?? "0.0.0"),
    kcp_version: asStr(raw["kcp_version"]),
    units: Array.isArray(raw["units"]) ? raw["units"].filter(isObj).map(parseUnit) : [],
    manifests: Array.isArray(raw["manifests"]) ? raw["manifests"].filter(isObj).map(parseManifestRef) : [],
    payment: parsePayment(raw["payment"]),
    rate_limits: parseRateLimits(raw["rate_limits"]),
    trust: ar
      ? {
          agent_requirements: {
            require_attestation: ar["require_attestation"] === undefined ? undefined : Boolean(ar["require_attestation"]),
            trusted_providers: asStrArr(ar["trusted_providers"]),
            attestation_url: asStr(ar["attestation_url"]),
          },
        }
      : undefined,
    signing,
    serving,
    source,
  };
}

/** Resolve a location (file, directory, or HTTPS URL) to manifest text + source label. */
export async function loadManifestText(location: string, fetchGuard: FetchGuard = {}): Promise<{ text: string; source: string }> {
  if (/^https?:\/\//.test(location)) {
    // Source is the FINAL post-redirect URL: it anchors relative signature/key
    // resolution to where the bytes actually came from, and it is the URL the
    // serving binding (§3.12 / C22) compares against serving.manifest.
    const { text, finalUrl } = await guardedFetchTextFinal(location, fetchGuard);
    return { text, source: finalUrl };
  }
  let path = location;
  if (existsSync(path) && statSync(path).isDirectory()) {
    const candidates = [join(path, "knowledge.yaml"), join(path, ".well-known", "knowledge.yaml")];
    const found = candidates.find((c) => existsSync(c));
    if (!found) throw new Error(`no knowledge.yaml found in ${path}`);
    path = found;
  }
  if (!existsSync(path)) throw new Error(`manifest not found: ${path}`);
  return { text: readFileSync(path, "utf8"), source: path };
}

/** Load and parse a manifest from a path, directory, or URL. */
export async function loadManifest(location: string, fetchGuard: FetchGuard = {}): Promise<Manifest> {
  const { text, source } = await loadManifestText(location, fetchGuard);
  return parseManifest(text, source);
}
