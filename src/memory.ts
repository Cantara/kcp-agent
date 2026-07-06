// Episodic memory — a log of hash-pinned, re-verifiable artifacts (epic #31).
//
// The thesis: a memory is a plan you can re-verify against a moved world. So a
// memory entry is NOT a summary or an embedding — it is the plan/grounded-answer
// artifact itself, stripped of the one thing that would make it dangerous to
// keep: the unit bytes. Caching restricted or paid content in the memory log
// would let a later recall read it without re-passing the access gate. We keep
// only what replay needs — id, path, sha256, and the citation table — so recall
// must re-fetch and re-verify against the live manifest every time.
//
// Entries are hash-addressed by their content-stripped artifact, so recording
// the same answer twice is idempotent and recall never double-counts an episode.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { terms } from "./planner.js";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export type MemoryKind = "plan" | "grounded-answer";

export interface MemoryEntry {
  /** sha256 of the content-stripped artifact — stable across re-records. */
  id: string;
  kind: MemoryKind;
  /** The task this artifact answered/planned for — the recall matching key. */
  task: string;
  manifestSource?: string;
  manifestSha?: string;
  /**
   * A stable digest of the planner inputs (role/methods/budget/…) this artifact
   * was produced under. A plan is a function of its options, so reuse (slice 3)
   * matches on this too — an episode made under different capabilities is a
   * different plan, not a cache hit. Absent for standalone-`remember` entries.
   */
  optionsKey?: string;
  /** When this entry was appended — NOT part of the id (so re-records dedup). */
  recordedAt: string;
  /** The content-stripped artifact: replay-sufficient, never the unit bytes. */
  artifact: unknown;
}

export interface MemoryStore {
  append(entry: MemoryEntry): Promise<void>;
  list(): Promise<MemoryEntry[]>;
}

/** The status a recalled episode carries once (or if) it is replayed. */
export type RecallStatus = "valid" | "drifted" | "unverifiable";

export interface Recalled {
  entry: MemoryEntry;
  /** Lexical task-term overlap with the query — higher is a closer episode. */
  score: number;
  status: RecallStatus;
  detail: string;
}

/** Injectable replay seam — re-verifies a recalled episode against the live world. */
export type RecallReplay = (
  entry: MemoryEntry,
) => Promise<{ ok: boolean; detail: string; unverifiable?: boolean }>;

export interface RecallOptions {
  replay?: RecallReplay;
  /** Cap the number of hits returned (default: all matches). */
  limit?: number;
}

// --- normalization: strip unit bytes, keep the replay skeleton ---------------

/** Recursively delete every `content` key — belt-and-suspenders against caching bytes. */
function dropContent(value: unknown): void {
  if (Array.isArray(value)) {
    for (const v of value) dropContent(v);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key === "content") delete obj[key];
      else dropContent(obj[key]);
    }
  }
}

/** Reduce a loaded artifact to what replay needs: no bytes, only id/path/sha + citations. */
function stripArtifact(raw: unknown): unknown {
  const artifact = JSON.parse(JSON.stringify(raw)) as Record<string, any>;
  const units = artifact?.synthesis?.unitsLoaded;
  if (Array.isArray(units)) {
    artifact.synthesis.unitsLoaded = units.map((u: any) => {
      const skeleton: Record<string, unknown> = { id: u.id, path: u.path };
      if (u.sha256 !== undefined) skeleton.sha256 = u.sha256;
      return skeleton;
    });
  }
  dropContent(artifact);
  return artifact;
}

function classify(raw: any): { kind: MemoryKind; task: string; manifest: any } {
  // A grounded answer wraps a plan and carries a grounding citation table.
  if (raw && typeof raw === "object" && "grounding" in raw && raw.plan) {
    return { kind: "grounded-answer", task: raw.plan.task, manifest: raw.plan.manifest };
  }
  return { kind: "plan", task: raw?.task, manifest: raw?.manifest };
}

/** Normalize a plan/grounded-answer artifact into a hash-addressed, byte-free memory entry. */
export function toEntry(raw: unknown, recordedAt: string, meta: { optionsKey?: string } = {}): MemoryEntry {
  const { kind, task, manifest } = classify(raw);
  const artifact = stripArtifact(raw);
  return {
    id: sha256(JSON.stringify(artifact)),
    kind,
    task,
    manifestSource: manifest?.source,
    manifestSha: manifest?.sha256,
    optionsKey: meta.optionsKey,
    recordedAt,
    artifact,
  };
}

// --- stores ------------------------------------------------------------------

export function inMemoryStore(seed: MemoryEntry[] = []): MemoryStore {
  const byId = new Map<string, MemoryEntry>();
  for (const e of seed) byId.set(e.id, e);
  return {
    async append(entry) {
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
    },
    async list() {
      return [...byId.values()];
    },
  };
}

/** A directory-backed store: one `<id>.json` per entry, so dedup and cross-instance reads are free. */
export function fileStore(dir: string): MemoryStore {
  mkdirSync(dir, { recursive: true });
  return {
    async append(entry) {
      writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry, null, 2));
    },
    async list() {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as MemoryEntry);
    },
  };
}

// --- recall ------------------------------------------------------------------

/** Recall episodes whose task lexically overlaps the query, ranked, each replay-validated if a hook is given. */
export async function recall(store: MemoryStore, task: string, opts: RecallOptions = {}): Promise<Recalled[]> {
  const query = new Set(terms(task));
  const scored = (await store.list())
    .map((entry) => {
      const overlap = terms(entry.task).filter((t) => query.has(t)).length;
      return { entry, score: overlap };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);

  const limited = opts.limit === undefined ? scored : scored.slice(0, opts.limit);

  return Promise.all(
    limited.map(async ({ entry, score }): Promise<Recalled> => {
      if (!opts.replay) {
        return { entry, score, status: "unverifiable", detail: "not replayed — recall carries no freshness claim" };
      }
      const r = await opts.replay(entry);
      const status: RecallStatus = r.unverifiable ? "unverifiable" : r.ok ? "valid" : "drifted";
      return { entry, score, status, detail: r.detail };
    }),
  );
}
