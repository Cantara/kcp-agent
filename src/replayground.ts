// Replaying a grounded answer — an answer is evidence; this is the cross-
// examination. `replay` re-verifies a *plan* against today's world; this
// re-verifies a grounded *answer*: each grounded claim's cited unit is re-read
// and its content sha256 re-compared to the pinned one. A citation that no
// longer holds (bytes changed, or the unit is gone) fails closed — a stale
// answer must never read as verified.
//
// Input is the full `ask --ground --json` artifact: the grounding claims carry
// unitId + pinned sha256, synthesis.unitsLoaded maps unitId → path, and the
// plan carries manifest.source. Content is re-read through the fetch guard.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { guardedFetchText, type FetchGuard } from "./fetch.js";

export type ClaimReplayStatus = "still-grounded" | "drifted" | "gone";
export type GapReplayStatus = "gap-persists" | "gap-closes";

export interface ClaimReplayCheck {
  claim: string;
  unitId: string;
  status: ClaimReplayStatus;
  detail: string;
}
export interface GapReplayCheck {
  claim: string;
  status: GapReplayStatus;
  detail: string;
}
export interface GroundedReplayReport {
  artifact: string;
  claims: ClaimReplayCheck[];
  gaps: GapReplayCheck[];
  /** True iff every grounded claim is still-grounded (no drift, nothing gone). */
  ok: boolean;
}

export interface GroundedReplayOptions {
  fetchGuard?: FetchGuard;
  /**
   * `--check-gaps`: re-navigate today's manifest and return which of the given
   * gap claims now ground (the manifest may have grown the missing evidence).
   * Injected — prod wires re-plan + load + re-ground; absent means gaps are
   * reported as persisting without re-navigation.
   */
  reground?: (task: string, gapClaims: string[]) => Promise<string[]>;
}

interface SavedClaim { claim: string; grounded: boolean; unitId?: string; sha256?: string; reason?: string }
interface SavedUnit { id: string; path: string; sha256?: string }

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Reject a unit path that could escape the manifest's directory or origin. */
function unsafePath(path: string): boolean {
  return isAbsolute(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.split("/").includes("..");
}

/** Re-read a unit's current content, from disk or over HTTPS relative to the manifest source. */
async function readUnit(source: string, path: string, guard: FetchGuard): Promise<string> {
  if (unsafePath(path)) throw new Error("unsafe path");
  if (/^https?:\/\//.test(source)) return await guardedFetchText(new URL(path, source).toString(), guard);
  return readFileSync(join(dirname(source), path), "utf8");
}

/** Locate the grounded-answer parts of an `ask --ground --json` artifact, or explain why it can't be replayed. */
function extract(json: unknown): { source: string; task: string; claims: SavedClaim[]; gaps: { claim: string }[]; units: Map<string, SavedUnit> } {
  const j = json as Record<string, unknown> | null;
  if (!j || typeof j !== "object") throw new Error("unrecognized artifact");
  const grounding = j.grounding as Record<string, unknown> | undefined;
  if (!grounding || !Array.isArray(grounding.claims)) {
    // A bare plan artifact, or anything without a grounding block.
    if (typeof j.task === "string" && Array.isArray(j.selected)) {
      throw new Error("this is a plan artifact — use `kcp-agent replay` for plans; grounded-answer replay needs an `ask --ground --json` artifact");
    }
    throw new Error("unrecognized artifact — expected the JSON output of `kcp-agent ask --ground --json` (plan + synthesis + grounding)");
  }
  const synthesis = j.synthesis as Record<string, unknown> | undefined;
  const unitsLoaded = synthesis?.unitsLoaded;
  if (!Array.isArray(unitsLoaded)) {
    throw new Error("artifact has no synthesis.unitsLoaded — re-verifying a grounded answer needs the full `ask --ground --json` artifact");
  }
  // manifest.source lives on the plan (single manifest) or the tree root.
  const plan = (j.plan ?? j) as Record<string, unknown>;
  const planNode = (plan.plan ?? plan) as Record<string, unknown>;
  const manifest = planNode.manifest as Record<string, unknown> | undefined;
  const source = manifest?.source;
  if (typeof source !== "string" || !source) {
    throw new Error("artifact has no manifest.source to re-fetch the cited units from");
  }
  const units = new Map<string, SavedUnit>();
  for (const u of unitsLoaded as SavedUnit[]) units.set(u.id, u);
  const task = typeof planNode.task === "string" ? planNode.task : "";
  return { source, task, claims: grounding.claims as SavedClaim[], gaps: (grounding.gaps as { claim: string }[]) ?? [], units };
}

/** Re-verify a grounded answer artifact against the live manifest and units. */
export async function replayGroundedAnswer(
  artifactJson: unknown,
  artifactName = "grounded-answer.json",
  options: GroundedReplayOptions = {}
): Promise<GroundedReplayReport> {
  const guard = options.fetchGuard ?? {};
  const { source, task, claims, gaps, units } = extract(artifactJson);
  const checks: ClaimReplayCheck[] = [];

  for (const c of claims) {
    if (!c.grounded || !c.unitId) continue;
    const unitId = c.unitId;
    if (!c.sha256) {
      checks.push({ claim: c.claim, unitId, status: "gone", detail: "claim carries no pinned sha — re-run `ask --ground` to refresh the artifact" });
      continue;
    }
    const unit = units.get(unitId);
    if (!unit) {
      checks.push({ claim: c.claim, unitId, status: "gone", detail: "cited unit is absent from synthesis.unitsLoaded" });
      continue;
    }
    let fresh: string;
    try {
      fresh = await readUnit(source, unit.path, guard);
    } catch (e) {
      checks.push({ claim: c.claim, unitId, status: "gone", detail: `unit no longer readable: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const digest = sha256(fresh);
    checks.push(
      digest === c.sha256
        ? { claim: c.claim, unitId, status: "still-grounded", detail: `sha ${digest.slice(0, 12)} unchanged` }
        : { claim: c.claim, unitId, status: "drifted", detail: `unit bytes changed: sha ${digest.slice(0, 12)}… ≠ pinned ${c.sha256.slice(0, 12)}…` }
    );
  }

  // A gap is reported as persisting unless --check-gaps re-navigates today's
  // manifest and finds newly-published evidence that now grounds the claim.
  let gapChecks: GapReplayCheck[];
  if (options.reground && gaps.length > 0) {
    const nowGrounded = new Set(await options.reground(task, gaps.map((g) => g.claim)));
    gapChecks = gaps.map((g) =>
      nowGrounded.has(g.claim)
        ? { claim: g.claim, status: "gap-closes", detail: "now grounds — the manifest gained evidence for this claim since the answer" }
        : { claim: g.claim, status: "gap-persists", detail: "still ungroundable against today's manifest" }
    );
  } else {
    gapChecks = gaps.map((g) => ({
      claim: g.claim,
      status: "gap-persists",
      detail: "not re-checked (pass --check-gaps to re-navigate for newly-published evidence)",
    }));
  }

  return {
    artifact: artifactName,
    claims: checks,
    gaps: gapChecks,
    ok: checks.length > 0 && checks.every((c) => c.status === "still-grounded"),
  };
}
