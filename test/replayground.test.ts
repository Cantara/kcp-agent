// Replaying a grounded answer — the answer is evidence; this cross-examines it
// against today's world. Each grounded claim's cited unit is re-read and its
// sha256 re-compared to the pinned one: still-grounded / drifted / gone.
// Written test-first; artifacts are hand-built (no LLM) and point at the real
// fjordwire example files so the re-hash is real.

import { describe, it, expect } from "vitest";
import { replayGroundedAnswer } from "../src/replayground.js";
import { formatGroundedReplay } from "../src/format.js";

// The real sha256 of examples/fjordwire/stories/chipfab-exclusive.md.
const REAL_SHA = "7d83d7dcbd74b02311aacd1d68aaa8f7ca90690a2ec0eeead5557b2cbcfebe36";

/** An `ask --ground --json` wrapper artifact citing one fjordwire unit. */
const artifact = (opts: { path?: string; pinnedSha?: string; gap?: boolean } = {}) => ({
  plan: { task: "who won", manifest: { source: "examples/fjordwire/knowledge.yaml", project: "fjordwire-newsstand" }, selected: [] },
  synthesis: { unitsLoaded: [{ id: "chipfab-exclusive", path: opts.path ?? "stories/chipfab-exclusive.md", sha256: opts.pinnedSha ?? REAL_SHA }] },
  grounding: {
    status: opts.gap ? "partial-unsupported" : "grounded",
    claims: [
      { claim: "Nordfab won the award.", grounded: true, unitId: "chipfab-exclusive", sha256: opts.pinnedSha ?? REAL_SHA },
      ...(opts.gap ? [{ claim: "The grid is constrained.", grounded: false, reason: "no loaded unit supports this claim" }] : []),
    ],
    gaps: opts.gap ? [{ claim: "The grid is constrained.", reason: "no loaded unit supports this claim" }] : [],
  },
});

describe("replayGroundedAnswer", () => {
  it("still-grounded: the cited unit's bytes are unchanged", async () => {
    const r = await replayGroundedAnswer(artifact());
    expect(r.ok).toBe(true);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0].status).toBe("still-grounded");
    expect(r.claims[0].unitId).toBe("chipfab-exclusive");
  });

  it("drifted: the unit's bytes no longer match the pinned sha — fail-closed (ok false)", async () => {
    const r = await replayGroundedAnswer(artifact({ pinnedSha: "dead".repeat(16) }));
    expect(r.ok).toBe(false);
    expect(r.claims[0].status).toBe("drifted");
    expect(r.claims[0].detail).toMatch(/sha/);
  });

  it("gone: the cited unit can no longer be read — fail-closed", async () => {
    const r = await replayGroundedAnswer(artifact({ path: "stories/removed.md" }));
    expect(r.ok).toBe(false);
    expect(r.claims[0].status).toBe("gone");
  });

  it("a gap persists by default (no re-navigation without --check-gaps)", async () => {
    const r = await replayGroundedAnswer(artifact({ gap: true }));
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].status).toBe("gap-persists");
    // the grounded claim is still fine, so the report is ok (a persisting gap was already known)
    expect(r.claims[0].status).toBe("still-grounded");
  });

  it("fail-closed: an artifact with no synthesis.unitsLoaded cannot be re-verified", async () => {
    const bad = { plan: { manifest: { source: "x" } }, grounding: { claims: [] } };
    await expect(replayGroundedAnswer(bad)).rejects.toThrow(/unitsLoaded|full .*artifact/i);
  });

  it("fail-closed: a plan artifact (not a grounded answer) is rejected with a clear message", async () => {
    const plan = { task: "t", selected: [], manifest: { source: "x" } };
    await expect(replayGroundedAnswer(plan)).rejects.toThrow(/grounded|grounding/i);
  });

  it("fail-closed: a grounded claim missing its pinned sha cannot be re-verified", async () => {
    const a = artifact();
    delete (a.grounding.claims[0] as { sha256?: string }).sha256;
    const r = await replayGroundedAnswer(a);
    expect(r.ok).toBe(false);
    expect(r.claims[0].status).toBe("gone");
    expect(r.claims[0].detail).toMatch(/no pinned sha|re-run/i);
  });

  describe("--check-gaps re-navigation", () => {
    it("gap-closes: a previously-unsupported claim now grounds against a grown manifest", async () => {
      // The injected reground stands in for re-plan + load + re-ground against
      // today's manifest; here the manifest has since gained the grounding unit.
      const reground = async (_task: string, claims: string[]) => claims; // all now ground
      const r = await replayGroundedAnswer(artifact({ gap: true }), "a.json", { reground });
      expect(r.gaps[0].status).toBe("gap-closes");
      expect(r.gaps[0].detail).toMatch(/now grounds|newly/i);
    });

    it("gap-persists: still ungroundable against today's manifest", async () => {
      const reground = async () => []; // nothing grounds
      const r = await replayGroundedAnswer(artifact({ gap: true }), "a.json", { reground });
      expect(r.gaps[0].status).toBe("gap-persists");
    });

    it("the reground seam gets the artifact's task and the gap claims", async () => {
      let seen: { task: string; claims: string[] } | undefined;
      const reground = async (task: string, claims: string[]) => { seen = { task, claims }; return []; };
      await replayGroundedAnswer(artifact({ gap: true }), "a.json", { reground });
      expect(seen?.task).toBe("who won");
      expect(seen?.claims).toEqual(["The grid is constrained."]);
    });
  });

  describe("formatGroundedReplay", () => {
    it("renders still-grounded and the verdict for an unchanged answer", async () => {
      const out = formatGroundedReplay(await replayGroundedAnswer(artifact()));
      expect(out).toContain("still-grounded");
      expect(out).toMatch(/✓|holds/i);
    });

    it("flags drift loudly", async () => {
      const out = formatGroundedReplay(await replayGroundedAnswer(artifact({ pinnedSha: "dead".repeat(16) })));
      expect(out).toContain("drifted");
      expect(out).toMatch(/✗|stale/i);
    });

    it("surfaces a gap that closes", async () => {
      const reground = async (_t: string, c: string[]) => c;
      const out = formatGroundedReplay(await replayGroundedAnswer(artifact({ gap: true }), "a.json", { reground }));
      expect(out).toContain("gap-closes");
    });
  });
});
