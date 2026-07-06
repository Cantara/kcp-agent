// Episodic memory — a log of hash-pinned, re-verifiable artifacts (epic #31,
// slice 2). Written test-first. The load-bearing behaviors:
//   1. content-stripping on ingest — a stored artifact NEVER retains unit bytes
//      (caching restricted/paid content would bypass the next access gate)
//   2. hash-addressed dedup — the same artifact recorded twice is one entry
//   3. deterministic lexical recall — matches by task-term overlap, ranked
//   4. replay-validated status — recall re-verifies each hit against the world

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toEntry, inMemoryStore, fileStore, recall, type MemoryEntry, type RecallReplay } from "../src/memory.js";

const AT = "2026-07-06T12:00:00.000Z";

const groundedArtifact = () => ({
  plan: { task: "who won the award", manifest: { source: "examples/fjordwire/knowledge.yaml", project: "fjordwire", sha256: "aa11" }, selected: [] },
  synthesis: {
    unitsLoaded: [
      { id: "chipfab-exclusive", path: "stories/chipfab-exclusive.md", manifest: "fjordwire", chars: 210, sha256: "7d83", content: "SECRET restricted bytes that must not be cached" },
    ],
  },
  grounding: { status: "grounded", claims: [{ claim: "Nordfab won.", grounded: true, unitId: "chipfab-exclusive", sha256: "7d83" }], gaps: [] },
});

const planArtifact = () => ({ task: "how do I deploy", manifest: { source: "examples/demo-hub/knowledge.yaml", project: "acme", sha256: "bb22" }, selected: [], options: {} });

describe("toEntry — normalize, strip content, hash-address", () => {
  it("classifies and extracts metadata from a grounded-answer artifact", () => {
    const e = toEntry(groundedArtifact(), AT);
    expect(e.kind).toBe("grounded-answer");
    expect(e.task).toBe("who won the award");
    expect(e.manifestSource).toBe("examples/fjordwire/knowledge.yaml");
    expect(e.manifestSha).toBe("aa11");
    expect(e.recordedAt).toBe(AT);
    expect(e.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("SECURITY: strips unit content on ingest but keeps id/path/sha for replay", () => {
    const e = toEntry(groundedArtifact(), AT);
    const json = JSON.stringify(e.artifact);
    expect(json).not.toContain("SECRET");
    expect(json).not.toMatch(/"content"/);
    const unit = (e.artifact as any).synthesis.unitsLoaded[0];
    expect(unit).toEqual({ id: "chipfab-exclusive", path: "stories/chipfab-exclusive.md", sha256: "7d83" });
    // the grounding table (the citations) is preserved
    expect((e.artifact as any).grounding.claims[0].unitId).toBe("chipfab-exclusive");
  });

  it("classifies a plan artifact and keeps it (already content-free)", () => {
    const e = toEntry(planArtifact(), AT);
    expect(e.kind).toBe("plan");
    expect(e.task).toBe("how do I deploy");
    expect(e.manifestSha).toBe("bb22");
  });

  it("is hash-addressed: the same artifact yields the same id regardless of recordedAt", () => {
    expect(toEntry(groundedArtifact(), AT).id).toBe(toEntry(groundedArtifact(), "2099-01-01T00:00:00.000Z").id);
  });
});

describe("stores", () => {
  it("in-memory append/list roundtrips and dedups by id", async () => {
    const store = inMemoryStore();
    const e = toEntry(groundedArtifact(), AT);
    await store.append(e);
    await store.append(e); // same id — idempotent
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(e.id);
  });

  it("file-backed append/list roundtrips across store instances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kcp-mem-"));
    const a = fileStore(dir);
    await a.append(toEntry(groundedArtifact(), AT));
    await a.append(toEntry(planArtifact(), AT));
    const b = fileStore(dir); // a fresh instance reads the same dir
    const all = await b.list();
    expect(all.map((e) => e.kind).sort()).toEqual(["grounded-answer", "plan"]);
  });
});

describe("recall", () => {
  const seed = (): MemoryEntry[] => [
    toEntry({ ...planArtifact(), task: "how do I deploy to production" }, "2026-07-01T00:00:00.000Z"),
    toEntry({ ...planArtifact(), task: "sovereign compute award winner" }, "2026-07-05T00:00:00.000Z"),
    toEntry({ ...planArtifact(), task: "quarterly revenue figures" }, "2026-07-06T00:00:00.000Z"),
  ];

  it("matches by lexical task overlap and ranks by score, ignoring unrelated episodes", async () => {
    const r = await recall(inMemoryStore(seed()), "who won the compute award");
    expect(r.length).toBe(1);
    expect(r[0].entry.task).toBe("sovereign compute award winner");
  });

  it("attaches replay-validated status to each hit", async () => {
    const replay: RecallReplay = async (e) =>
      e.task.includes("deploy") ? { ok: false, detail: "a cited unit drifted" } : { ok: true, detail: "still valid" };
    const r = await recall(inMemoryStore(seed()), "deploy production release", { replay });
    expect(r[0].entry.task).toBe("how do I deploy to production");
    expect(r[0].status).toBe("drifted");
    expect(r[0].detail).toMatch(/drifted/);
  });

  it("without a replay hook, hits are returned unverified (never falsely 'valid')", async () => {
    const r = await recall(inMemoryStore(seed()), "compute award");
    expect(r[0].status).toBe("unverifiable");
  });
});
