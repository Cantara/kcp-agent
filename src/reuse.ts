// Memory-validated reuse — a determinism-preserving cache (epic #31, slice 3).
//
// A plan is a pure function of (manifest bytes, task, options). So a prior
// episode is safe to reuse for a new request iff it matches on ALL of those
// coordinates AND still replays clean against today's world:
//
//   recall (exact match) + replay (freshness) = reuse
//
// Everything else is fail-closed. If the manifest drifted since the episode we
// NEVER reuse — we say exactly what changed and let the caller re-navigate. If
// we cannot verify freshness at all (no replay hook, or the replay could not
// run), reuse is refused as `unverifiable`, never granted on faith. A forged or
// stale memory entry must not be able to steer the next plan.

import type { MemoryEntry, MemoryKind, MemoryStore, RecallReplay } from "./memory.js";

export type ReuseStatus = "reuse" | "drifted" | "unverifiable" | "miss";

export interface ReuseRequest {
  task: string;
  manifestSource: string;
  /** The planner-input digest the request runs under — must match the episode's. */
  optionsKey?: string;
  /** Restrict to plan vs grounded-answer episodes (`ask` reuses answers, `plan` reuses plans). */
  kind?: MemoryKind;
}

export interface ReuseDecision {
  status: ReuseStatus;
  /** The matched episode, when one was found (any status but `miss`). */
  entry?: MemoryEntry;
  detail: string;
  /** The reusable artifact — present ONLY when status is `reuse` (provably current). */
  artifact?: unknown;
}

export interface ReuseOptions {
  /** Freshness seam — reuse is granted only if the episode still replays clean today. */
  replay?: RecallReplay;
}

function sameOptions(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "") === (b ?? "");
}

/** Decide whether a prior episode can be reused for this request, fail-closed on any drift or doubt. */
export async function reuse(store: MemoryStore, req: ReuseRequest, opts: ReuseOptions = {}): Promise<ReuseDecision> {
  const candidates = (await store.list()).filter(
    (e) =>
      e.task === req.task &&
      e.manifestSource === req.manifestSource &&
      sameOptions(e.optionsKey, req.optionsKey) &&
      (req.kind === undefined || e.kind === req.kind),
  );
  if (candidates.length === 0) {
    return { status: "miss", detail: "no prior episode for this task + manifest + options" };
  }

  // The freshest snapshot of this exact request is the one to re-verify.
  const entry = candidates.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))[0];

  if (!opts.replay) {
    return { status: "unverifiable", entry, detail: "no replay hook — cannot confirm the manifest is unchanged; refusing reuse (fail-closed)" };
  }

  const r = await opts.replay(entry);
  if (r.unverifiable) {
    return { status: "unverifiable", entry, detail: `could not verify freshness: ${r.detail}; refusing reuse` };
  }
  if (!r.ok) {
    return { status: "drifted", entry, detail: r.detail };
  }
  return { status: "reuse", entry, artifact: entry.artifact, detail: r.detail };
}
