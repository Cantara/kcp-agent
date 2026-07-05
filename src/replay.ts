// Replay — determinism as a verifiable property, not a slogan.
//
// A `plan --json` artifact carries the manifest's sha256 and an echo of the
// planner inputs. `kcp-agent replay <plan.json>` re-fetches each manifest,
// compares the bytes, re-runs the pure planner with the saved inputs, and
// compares the fresh plan to the saved one. Everything identical → exit 0.
// Anything that moved — manifest bytes, planner behavior — is reported as
// drift, per manifest, with the fields that differ. The saved plan is
// evidence; replay is the cross-examination.

import { createHash } from "node:crypto";
import { loadManifestText, parseManifest } from "./client.js";
import { plan, type AgentPlan } from "./planner.js";

export interface ReplayCheck {
  source: string;
  project: string;
  status: "identical" | "drifted" | "error";
  detail: string;
  /** Top-level plan fields that differ, when drifted at the plan level. */
  fields?: string[];
}

export interface ReplayReport {
  artifact: string;
  checks: ReplayCheck[];
  ok: boolean;
}

interface TreeShape {
  plan?: AgentPlan;
  children?: TreeShape[];
}

/** Accept any artifact shape the CLI emits: a single plan, a --follow tree, or an `ask --json` wrapper. */
export function collectSavedPlans(json: unknown): AgentPlan[] {
  const j = json as Record<string, unknown> | null;
  if (j && typeof j === "object") {
    if (typeof j.task === "string" && Array.isArray(j.selected)) return [j as unknown as AgentPlan];
    if (Array.isArray(j.children)) {
      const out: AgentPlan[] = [];
      const walk = (n: TreeShape): void => {
        if (n.plan) out.push(n.plan);
        for (const child of n.children ?? []) walk(child);
      };
      walk(j as TreeShape);
      return out;
    }
    if (j.plan) return collectSavedPlans(j.plan);
  }
  throw new Error("unrecognized artifact — expected the JSON output of `kcp-agent plan --json` (a plan or a --follow tree)");
}

/** Strip what the pure planner cannot reproduce: fields attached by the loading layer. */
function comparable(p: AgentPlan): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  delete c.signature;
  const m = c.manifest as Record<string, unknown> | undefined;
  if (m) delete m.sha256;
  return c;
}

/** Replay every plan in a saved artifact against the live manifests. */
export async function replayArtifact(artifactJson: unknown, artifactName = "plan.json"): Promise<ReplayReport> {
  const saved = collectSavedPlans(artifactJson);
  const checks: ReplayCheck[] = [];

  for (const s of saved) {
    const source = s.manifest?.source;
    const project = s.manifest?.project ?? "(unknown)";
    if (!source) {
      checks.push({ source: "(none)", project, status: "error", detail: "saved plan has no manifest.source to re-fetch" });
      continue;
    }
    if (!s.options) {
      checks.push({
        source, project, status: "error",
        detail: "saved plan carries no echoed planner options — the artifact predates replay support; re-plan to refresh it",
      });
      continue;
    }

    let text: string;
    let resolvedSource: string;
    try {
      ({ text, source: resolvedSource } = await loadManifestText(source));
    } catch (e) {
      checks.push({ source, project, status: "error", detail: `fetch failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    // Bytes first: if the manifest changed, the plan is stale by definition.
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    if (s.manifest.sha256 && digest !== s.manifest.sha256) {
      checks.push({
        source, project, status: "drifted",
        detail: `manifest bytes changed: sha256 ${digest.slice(0, 12)}… ≠ saved ${s.manifest.sha256.slice(0, 12)}…`,
      });
      continue;
    }

    let fresh: AgentPlan;
    try {
      const manifest = parseManifest(text, resolvedSource);
      fresh = plan(manifest, s.task, {
        capabilities: s.options.capabilities,
        env: s.environment,
        asOf: s.asOf,
        maxUnits: s.options.maxUnits,
        strict: s.options.strict,
        budget: s.options.budget,
      });
    } catch (e) {
      checks.push({ source, project, status: "error", detail: `re-plan failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    const a = comparable(s);
    const b = comparable(fresh);
    if (JSON.stringify(a) === JSON.stringify(b)) {
      checks.push({
        source, project, status: "identical",
        detail:
          `${fresh.selected.length} selected, ${fresh.skipped.length} skipped — plan reproduced byte-identically` +
          (s.manifest.sha256 ? ", manifest sha256 matches" : " (saved artifact carried no manifest sha256)"),
      });
      continue;
    }
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .sort();
    checks.push({ source, project, status: "drifted", detail: `plan differs in: ${fields.join(", ")}`, fields });
  }

  return { artifact: artifactName, checks, ok: checks.length > 0 && checks.every((c) => c.status === "identical") };
}
