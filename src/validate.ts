// Manifest linter — `kcp-agent validate` for knowledge.yaml publishers.
//
// Validates the same compact model the planner consumes, so "validates clean"
// means "this agent can navigate it". Errors are structural problems that will
// mislead or fail an agent; warnings are declarations that weaken navigation
// (empty triggers, stale temporal blocks) but don't break it.

import { existsSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { loadManifestText, parseManifest } from "./client.js";
import { terms } from "./planner.js";
import type { Manifest, Unit } from "./model.js";

export interface Finding {
  level: "error" | "warning";
  where: string; // e.g. "unit 'deploy-guide'" or "manifest"
  message: string;
}

export interface ValidationReport {
  source: string;
  project?: string;
  findings: Finding[];
  /** No errors (warnings allowed). */
  ok: boolean;
}

const ACCESS_VALUES = new Set(["public", "authenticated", "restricted"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

function unsafePath(path: string): string | undefined {
  if (path === "") return "path is empty";
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return "path must be relative, not a URL";
  if (isAbsolute(path)) return "path must be relative, not absolute";
  if (path.split("/").includes("..")) return "path must not traverse with '..'";
  return undefined;
}

/** Validate a parsed manifest. `baseDir` enables unit-path existence checks. */
export function validateManifest(manifest: Manifest, baseDir?: string): Finding[] {
  const findings: Finding[] = [];
  const err = (where: string, message: string) => findings.push({ level: "error", where, message });
  const warn = (where: string, message: string) => findings.push({ level: "warning", where, message });

  if (manifest.project === "(unnamed)") warn("manifest", "missing 'project'");
  if (manifest.version === "0.0.0") warn("manifest", "missing 'version'");
  if (!manifest.kcp_version) warn("manifest", "missing 'kcp_version' — agents cannot tell which spec revision this targets");
  if (manifest.units.length === 0) warn("manifest", "declares no units — nothing for an agent to navigate");

  const ids = new Set<string>();
  for (const unit of manifest.units) {
    const where = `unit '${unit.id || "(no id)"}'`;
    if (!unit.id) err(where, "missing 'id'");
    else if (ids.has(unit.id)) err(where, "duplicate unit id");
    ids.add(unit.id);

    const pathProblem = unsafePath(unit.path);
    if (pathProblem) err(where, pathProblem);
    else if (baseDir !== undefined && !existsSync(join(baseDir, unit.path))) {
      err(where, `path '${unit.path}' does not exist`);
    }

    if (!unit.intent) err(where, "missing 'intent' — intent is the primary navigation signal");
    if (unit.triggers.length === 0) warn(where, "no 'triggers' — unit is only findable through its intent text");
    if (unit.audience.length === 0) warn(where, "no 'audience' — declare who this unit serves (e.g. [agent, human])");
    if (unit.access && !ACCESS_VALUES.has(unit.access)) {
      warn(where, `unknown access '${unit.access}' (expected public/authenticated/restricted)`);
    }
    validateTemporal(unit, where, findings);
    validateNotFor(unit, where, findings);
    for (const m of unit.payment?.methods ?? []) {
      if (!m.type) err(where, "payment method missing 'type'");
      if (m.type === "x402" && (!m.price_per_request || !m.currency)) {
        warn(where, "x402 payment method should declare 'price_per_request' and 'currency'");
      }
    }
  }
  // superseded_by references are checked after all ids are collected
  for (const unit of manifest.units) {
    const succ = unit.temporal?.superseded_by;
    if (succ && !ids.has(succ)) {
      err(`unit '${unit.id}'`, `temporal.superseded_by references unknown unit '${succ}'`);
    }
  }

  const refIds = new Set<string>();
  for (const ref of manifest.manifests) {
    const where = `manifest ref '${ref.id || "(no id)"}'`;
    if (!ref.id) err(where, "missing 'id'");
    else if (refIds.has(ref.id)) err(where, "duplicate manifest ref id");
    refIds.add(ref.id);
    if (!ref.url) err(where, "missing 'url'");
    else if (!/^https:\/\//.test(ref.url)) warn(where, `url is not https — agents should fetch federation over TLS`);
    if (ref.agent_identity?.required && !ref.agent_identity.credential_hint) {
      warn(where, "agent_identity.required without 'credential_hint' — agents cannot plan credential acquisition");
    }
  }

  const ar = manifest.trust?.agent_requirements;
  if (ar?.require_attestation && (ar.trusted_providers ?? []).length === 0) {
    err("manifest", "require_attestation with no trusted_providers — no agent can ever qualify (permanently fail-closed)");
  }

  if (manifest.signing && manifest.signing.scheme && !/^(ed25519|eddsa)$/i.test(manifest.signing.scheme)) {
    warn("manifest", `signing scheme '${manifest.signing.scheme}' is not one this agent can verify (ed25519)`);
  }

  return findings;
}

/**
 * The self-sabotaging gate: at plan time a `not_for` entry gates the unit
 * whenever any task term appears inside it. The most natural questions for a
 * unit are phrased in the unit's own vocabulary — so a `not_for` written as a
 * natural-language negation ("questions about non-AI software systems") that
 * contains the unit's own intent/trigger terms deterministically locks the
 * gate on exactly the audience the unit exists to serve. Found live in a
 * production regulatory manifest; a machine can flag it at publish time.
 */
function validateNotFor(unit: Unit, where: string, findings: Finding[]) {
  const notFor = unit.not_for ?? [];
  if (notFor.length === 0) return;
  const vocabulary = new Set<string>([...terms(unit.intent), ...unit.triggers.flatMap((t) => terms(t))]);
  for (const nf of notFor) {
    const entry = nf.toLowerCase();
    const hits = [...vocabulary].filter((v) => entry.includes(v)).sort();
    if (hits.length > 0) {
      findings.push({
        level: "warning",
        where,
        message:
          `not_for '${nf}' contains the unit's own vocabulary (${hits.join(", ")}) — ` +
          `term matching will gate this unit against its most natural questions; ` +
          `name the excluded topic in its own words (e.g. "CCPA", "accounting"), never as a negation of this unit's topic ("non-X", "outside X")`,
      });
    }
  }
}

function validateTemporal(unit: Unit, where: string, findings: Finding[]) {
  const t = unit.temporal;
  if (!t) return;
  const err = (message: string) => findings.push({ level: "error", where, message });
  const warn = (message: string) => findings.push({ level: "warning", where, message });
  if (t.valid_from && !ISO_DATE.test(t.valid_from)) err(`temporal.valid_from '${t.valid_from}' is not an ISO date`);
  if (t.valid_until && !ISO_DATE.test(t.valid_until)) err(`temporal.valid_until '${t.valid_until}' is not an ISO date`);
  if (t.valid_from && t.valid_until && t.valid_until < t.valid_from) {
    err(`temporal window ends (${t.valid_until}) before it starts (${t.valid_from})`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (t.valid_until && ISO_DATE.test(t.valid_until) && t.valid_until < today && !t.superseded_by) {
    warn(`expired ${t.valid_until} with no 'superseded_by' — agents get a dead end instead of a successor`);
  }
}

/** Load a manifest from a path/dir/URL and validate it. */
export async function validateLocation(location: string): Promise<ValidationReport> {
  let text: string;
  let source: string;
  try {
    ({ text, source } = await loadManifestText(location));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { source: location, findings: [{ level: "error", where: "manifest", message }], ok: false };
  }
  let manifest: Manifest;
  try {
    manifest = parseManifest(text, source);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { source, findings: [{ level: "error", where: "manifest", message: `does not parse: ${message}` }], ok: false };
  }
  const baseDir = /^https?:\/\//.test(source) ? undefined : dirname(source);
  const findings = validateManifest(manifest, baseDir);
  return {
    source,
    project: manifest.project,
    findings,
    ok: !findings.some((f) => f.level === "error"),
  };
}
