// MCP session dedup — the caller-side of episodic memory (epic #31, slice 4).
//
// The other consumer of the artifact log isn't kcp-agent's own history; it's the
// calling agent's MCP session. Its context window IS the session state, so the
// server stays stateless and in character (explicit, not ambient): the caller
// declares the units it already holds — `id → sha256` — and `kcp_load` withholds
// the bytes it would otherwise re-serve, returning an "unchanged" stub instead.
// Real token savings for the caller's window.
//
// The one rule that makes this safe: a stub is only emitted on an EXACT sha
// match. If the caller's copy is stale (the unit drifted), the fresh bytes are
// re-served — an "unchanged" claim is a literal assertion that the bytes are
// identical, never a shortcut that hides a change. And because `kcp_load`
// re-plans (and so re-gates) every call, a unit the caller has since lost access
// to simply isn't in the loaded set — dedup can't smuggle it back as a stub.

import type { LoadedUnit } from "./synthesize.js";

/** What the caller already holds unchanged: an id→sha256 map, or an array of {id, sha256}. */
export type KnownUnits = Record<string, string> | Array<{ id: string; sha256: string }>;

export interface UnchangedUnit {
  id: string;
  path: string;
  sha256: string;
  unchanged: true;
  note: string;
}

export type EmittedUnit = LoadedUnit | UnchangedUnit;

export interface DedupResult {
  units: EmittedUnit[];
  /** Units the caller already had at the same sha — their bytes were withheld. */
  deduped: Array<{ id: string; sha256: string }>;
  /** Content characters withheld — the caller's context-window saving. */
  bytesSaved: number;
}

/** Normalize the caller's declared set into an id→sha256 lookup. */
export function knownMap(known?: KnownUnits): Map<string, string> {
  const m = new Map<string, string>();
  if (!known) return m;
  if (Array.isArray(known)) {
    for (const k of known) if (k && typeof k.id === "string") m.set(k.id, String(k.sha256));
  } else {
    for (const [id, sha] of Object.entries(known)) m.set(id, String(sha));
  }
  return m;
}

/** Withhold the bytes of any loaded unit the caller already holds at the same sha; serve the rest. */
export function dedupeLoaded(loaded: LoadedUnit[], known?: KnownUnits): DedupResult {
  const have = knownMap(known);
  const units: EmittedUnit[] = [];
  const deduped: Array<{ id: string; sha256: string }> = [];
  let bytesSaved = 0;
  for (const u of loaded) {
    if (have.get(u.id) === u.sha256) {
      units.push({
        id: u.id,
        path: u.path,
        sha256: u.sha256,
        unchanged: true,
        note: `unchanged since your copy (sha ${u.sha256.slice(0, 12)}…) — not re-served`,
      });
      deduped.push({ id: u.id, sha256: u.sha256 });
      bytesSaved += u.content.length;
    } else {
      units.push(u);
    }
  }
  return { units, deduped, bytesSaved };
}
