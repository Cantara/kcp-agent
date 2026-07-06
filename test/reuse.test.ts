// Memory-validated reuse — a determinism-preserving cache (epic #31, slice 3).
// Written test-first. The discipline: recall + replay = reuse.
//
// A plan is a pure function of (manifest bytes, task, options). So a prior
// episode is safe to reuse for a new request iff it matches on ALL of those
// coordinates AND still replays clean against today's world. Anything less is
// fail-closed:
//   - manifest drifted since the episode → NEVER reuse (say what changed)
//   - can't verify freshness (no replay hook / replay couldn't run) → refuse
//   - different task / options / manifest → cache miss, not a false hit

import { describe, it, expect } from "vitest";
import { toEntry, inMemoryStore, type RecallReplay } from "../src/memory.js";
import { reuse } from "../src/reuse.js";

const plan = (task: string, selected: string[] = []) => ({
  task,
  manifest: { source: "knowledge.yaml", project: "acme", sha256: "bb22" },
  selected,
  options: {},
});

const OK: RecallReplay = async () => ({ ok: true, detail: "manifest@bb22 unchanged — provably the same plan" });

describe("reuse — exact-match, replay-validated determinism cache", () => {
  const store = () =>
    inMemoryStore([toEntry(plan("deploy to prod"), "2026-07-01T00:00:00.000Z", { optionsKey: "role=agent" })]);
  const req = { task: "deploy to prod", manifestSource: "knowledge.yaml", optionsKey: "role=agent" };

  it("grants reuse when the episode matches and still replays clean", async () => {
    const d = await reuse(store(), req, { replay: OK });
    expect(d.status).toBe("reuse");
    expect((d.artifact as any).task).toBe("deploy to prod");
    expect(d.entry?.optionsKey).toBe("role=agent");
    expect(d.detail).toMatch(/unchanged/);
  });

  it("FAIL-CLOSED: refuses reuse when the manifest drifted since the episode", async () => {
    const drift: RecallReplay = async () => ({ ok: false, detail: "manifest sha changed: bb22… ≠ cc33…" });
    const d = await reuse(store(), req, { replay: drift });
    expect(d.status).toBe("drifted");
    expect(d.artifact).toBeUndefined();
    expect(d.detail).toMatch(/sha changed/);
  });

  it("FAIL-CLOSED: without a replay hook, reuse is refused as unverifiable (never granted on faith)", async () => {
    const d = await reuse(store(), req);
    expect(d.status).toBe("unverifiable");
    expect(d.artifact).toBeUndefined();
  });

  it("FAIL-CLOSED: a replay that could not run is unverifiable, not reuse", async () => {
    const cannot: RecallReplay = async () => ({ ok: false, unverifiable: true, detail: "manifest unreachable" });
    const d = await reuse(store(), req, { replay: cannot });
    expect(d.status).toBe("unverifiable");
    expect(d.artifact).toBeUndefined();
  });

  it("misses on a different task, a different options set, or a different manifest", async () => {
    expect((await reuse(store(), { ...req, task: "roll back prod" }, { replay: OK })).status).toBe("miss");
    expect((await reuse(store(), { ...req, optionsKey: "role=admin" }, { replay: OK })).status).toBe("miss");
    expect((await reuse(store(), { ...req, manifestSource: "other.yaml" }, { replay: OK })).status).toBe("miss");
  });

  it("reuses the most recent matching snapshot when the episode was recorded more than once", async () => {
    const s = inMemoryStore([
      toEntry(plan("deploy to prod", ["a"]), "2026-07-01T00:00:00.000Z", { optionsKey: "role=agent" }),
      toEntry(plan("deploy to prod", ["a", "b"]), "2026-07-05T00:00:00.000Z", { optionsKey: "role=agent" }),
    ]);
    const d = await reuse(s, req, { replay: OK });
    expect(d.status).toBe("reuse");
    expect((d.artifact as any).selected).toEqual(["a", "b"]);
  });

  it("honours a kind filter so `ask` reuses answers and `plan` reuses plans", async () => {
    const grounded = {
      plan: { task: "deploy to prod", manifest: { source: "knowledge.yaml", sha256: "bb22" }, selected: [] },
      synthesis: { answer: "Run make deploy.", unitsLoaded: [] },
      grounding: { status: "grounded", claims: [], gaps: [] },
    };
    const s = inMemoryStore([
      toEntry(plan("deploy to prod"), "2026-07-01T00:00:00.000Z", { optionsKey: "role=agent" }),
      toEntry(grounded, "2026-07-02T00:00:00.000Z", { optionsKey: "role=agent" }),
    ]);
    const asAnswer = await reuse(s, { ...req, kind: "grounded-answer" }, { replay: OK });
    expect(asAnswer.entry?.kind).toBe("grounded-answer");
    const asPlan = await reuse(s, { ...req, kind: "plan" }, { replay: OK });
    expect(asPlan.entry?.kind).toBe("plan");
  });
});
