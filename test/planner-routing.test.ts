import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan, scoreUnit, terms } from "../src/planner.js";
import { trace } from "../src/trace.js";

const unit = (overrides: Record<string, unknown> = {}) => ({
  id: "guide",
  path: "docs/guide.md",
  intent: "Delivery procedure",
  audience: ["agent"],
  triggers: [] as string[],
  ...overrides,
});

const manifest = (units: ReturnType<typeof unit>[]) => ({
  project: "routing",
  version: "1.0.0",
  units,
  manifests: [],
});

describe("precise lexical scoring (#152)", () => {
  it("deduplicates repeated query terms before scoring", () => {
    const source = unit({
      id: "sources-workflow",
      path: "docs/sources.md",
      intent: "Segment source workflow",
      triggers: ["segment"],
    });

    expect(terms("segment segment segment")).toEqual(["segment"]);
    const scored = scoreUnit(source, ["segment", "segment"]);
    expect(scored.score).toBe(7);
    expect(scored.matches).toEqual({ intent: ["segment"], triggers: ["segment"], idPath: [] });
  });

  it("matches complete Unicode tokens, not arbitrary character substrings", () => {
    const access = manifest([
      unit({ id: "another-access", intent: "Access for another collaborator", triggers: ["another"] }),
      unit({ id: "ownership-access", intent: "Access control and ownership", triggers: ["ownership"] }),
    ]);

    expect(plan(access, "not", {}).selected).toEqual([]);
    expect(plan(access, "owner", {}).selected).toEqual([]);

    const norsk = unit({ intent: "Grønn omstilling av kraftnettet", triggers: ["grønn", "kraftnett"] });
    expect(scoreUnit(norsk, terms("grønn energi")).matches.triggers).toEqual(["grønn"]);
  });

  it("keeps variants deterministic through explicit triggers", () => {
    const variants = unit({ triggers: ["deploy", "deployed"] });
    expect(scoreUnit(variants, terms("deployed")).score).toBe(4);
    expect(scoreUnit(variants, terms("deployment")).score).toBe(0);
  });

  it("attributes every score contribution to exact terms and fields", () => {
    const source = unit({
      id: "segment-guide",
      path: "docs/segment.md",
      intent: "Segment anchor guide",
      triggers: ["segment", "anchor"],
    });
    const scored = scoreUnit(source, terms("segment anchor"));

    expect(scored.score).toBe(16);
    expect(scored.reasons).toEqual([
      'intent matches 2 term(s): ["segment","anchor"]',
      'triggers match 2 term(s): ["segment","anchor"]',
      'id/path matches 1 term(s): ["segment"]',
    ]);
  });
});

describe("negative routing (#152, KCP §4.20)", () => {
  const yaml = `
project: negative-routing
version: 1.0.0
units:
  - id: clean-policy
    path: docs/clean.md
    intent: "GDPR data residency guidance"
    audience: [agent]
    triggers: [gdpr, residency]
  - id: advisory-policy
    path: docs/advisory.md
    intent: "GDPR data residency guidance"
    audience: [agent]
    triggers: [gdpr, residency]
    not_for: [medical advice]
    not_for_strict: false
  - id: strict-policy
    path: docs/strict.md
    intent: "GDPR data residency guidance"
    audience: [agent]
    triggers: [gdpr, residency]
    not_for: [medical advice]
    not_for_strict: true
  - id: bounded-negative
    path: docs/bounded.md
    intent: "Access control guidance"
    audience: [agent]
    triggers: [access]
    not_for: [another team's ownership transfer]
`;
  const parsed = parseManifest(yaml, "test");

  it("parses not_for_strict and soft-demotes advisory matches", () => {
    expect(parsed.units.find((u) => u.id === "advisory-policy")?.not_for_strict).toBe(false);
    expect(parsed.units.find((u) => u.id === "strict-policy")?.not_for_strict).toBe(true);

    const p = plan(parsed, "gdpr medical advice", { maxUnits: 10 });
    const clean = p.selected.find((u) => u.id === "clean-policy")!;
    const advisory = p.selected.find((u) => u.id === "advisory-policy")!;

    expect(clean.score).toBe(7);
    expect(advisory.score).toBe(3);
    expect(advisory.caution).toBe("not_for match: 'medical advice'");
    expect(advisory.reasons.at(-1)).toBe(
      `not_for advisory match 'medical advice' (matched term(s): ["medical","advice"]); score demoted from 7 to 3`,
    );
    expect(p.selected.indexOf(clean)).toBeLessThan(p.selected.indexOf(advisory));
  });

  it("hard-excludes only an exact-token not_for match with not_for_strict: true", () => {
    const p = plan(parsed, "gdpr medical advice", { maxUnits: 10 });
    expect(p.selected.some((u) => u.id === "strict-policy")).toBe(false);
    expect(p.skipped.find((u) => u.id === "strict-policy")?.reason).toBe(
      `not_for declares it does not serve 'medical advice'`,
    );

    const bounded = plan(parsed, "access not owner", { maxUnits: 10 });
    const hit = bounded.selected.find((u) => u.id === "bounded-negative");
    expect(hit).toBeDefined();
    expect(hit?.caution).toBeUndefined();
  });

  it("uses the same scoring and negative-routing decision in plan and trace", () => {
    const p = plan(parsed, "gdpr medical advice", { maxUnits: 10 });
    const t = trace(parsed, "gdpr medical advice", { maxUnits: 10 });
    const planned = p.selected.find((u) => u.id === "advisory-policy")!;
    const traced = t.units.find((u) => u.id === "advisory-policy")!;

    expect(traced.score).toBe(planned.score);
    expect(traced.caution).toBe(planned.caution);
    expect(traced.gates.find((g) => g.gate === "relevance")?.detail).toBe(
      'score 7: intent matches 1 term(s): ["gdpr"]; triggers match 1 term(s): ["gdpr"]',
    );
    expect(traced.gates.find((g) => g.gate === "not_for")?.detail).toBe(planned.reasons.at(-1));

    const strict = t.units.find((u) => u.id === "strict-policy")!;
    expect(strict.rejectedBy).toBe("not_for");
    expect(strict.gates.map((g) => g.gate)).toEqual(["audience", "relevance", "not_for"]);
    expect(strict.gates[1].detail).toContain('intent matches 1 term(s): ["gdpr"]');
  });
});
