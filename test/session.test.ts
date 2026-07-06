// MCP session dedup — don't re-serve unit bytes the caller already holds
// (epic #31, slice 4). Written test-first. The server stays stateless: the
// caller declares what it has (id → sha256), and dedup withholds bytes ONLY on
// an exact sha match. Any drift re-serves the full content — an "unchanged"
// stub is a literal claim that the bytes are identical, never a stale shortcut.

import { describe, it, expect } from "vitest";
import { dedupeLoaded, type EmittedUnit } from "../src/session.js";
import type { LoadedUnit } from "../src/synthesize.js";

const unit = (id: string, content: string, sha: string): LoadedUnit => ({
  id,
  path: `docs/${id}.md`,
  manifest: "acme",
  chars: content.length,
  sha256: sha,
  content,
});

const isStub = (u: EmittedUnit): boolean => (u as { unchanged?: boolean }).unchanged === true;

describe("dedupeLoaded — withhold bytes the caller already has, re-serve on drift", () => {
  const loaded = [unit("a", "alpha bytes", "aaa"), unit("b", "bravo bytes", "bbb")];

  it("withholds the content of a unit the caller holds at the same sha", () => {
    const r = dedupeLoaded(loaded, [{ id: "a", sha256: "aaa" }]);
    const a = r.units.find((u) => u.id === "a")!;
    expect(isStub(a)).toBe(true);
    expect((a as { content?: string }).content).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain("alpha bytes");
    expect(r.deduped).toEqual([{ id: "a", sha256: "aaa" }]);
    expect(r.bytesSaved).toBe("alpha bytes".length);
  });

  it("still serves the full bytes of a unit the caller does NOT have", () => {
    const r = dedupeLoaded(loaded, [{ id: "a", sha256: "aaa" }]);
    const b = r.units.find((u) => u.id === "b")!;
    expect(isStub(b)).toBe(false);
    expect((b as LoadedUnit).content).toBe("bravo bytes");
  });

  it("FAIL-CLOSED: a stale caller sha (unit drifted) re-serves the fresh bytes, never a stub", () => {
    const r = dedupeLoaded(loaded, [{ id: "a", sha256: "OLD-SHA" }]);
    const a = r.units.find((u) => u.id === "a")!;
    expect(isStub(a)).toBe(false);
    expect((a as LoadedUnit).content).toBe("alpha bytes");
    expect(r.deduped).toEqual([]);
    expect(r.bytesSaved).toBe(0);
  });

  it("accepts the known set as an id→sha map as well as an array", () => {
    const r = dedupeLoaded(loaded, { a: "aaa", b: "bbb" });
    expect(r.units.every(isStub)).toBe(true);
    expect(r.bytesSaved).toBe("alpha bytes".length + "bravo bytes".length);
  });

  it("with no known set, serves everything (a first-contact session)", () => {
    const r = dedupeLoaded(loaded);
    expect(r.units.some(isStub)).toBe(false);
    expect(r.deduped).toEqual([]);
  });
});
