import { describe, it, expect } from "vitest";
import { planTree, plans } from "../src/follow.js";
import { synthesize, loadPlannedUnits } from "../src/synthesize.js";

const HUB = "test/fixtures/fed/hub";
const TASK = "how do I deploy?";

describe("planTree", () => {
  it("does not follow federation by default", async () => {
    const tree = await planTree(HUB, TASK, {});
    expect(tree.children).toHaveLength(0);
    expect(tree.notFollowed.find((r) => r.id === "child")?.reason).toContain("beyond max depth");
  });

  it("follows eligible refs one hop and plans them", async () => {
    const tree = await planTree(HUB, TASK, { maxDepth: 1 });
    expect(tree.plan?.manifest.project).toBe("fed-hub");
    const child = tree.children.find((c) => c.refId === "child");
    expect(child?.plan?.manifest.project).toBe("fed-child");
    expect(child?.plan?.selected.map((u) => u.id)).toContain("child-deploy");
  });

  it("fails closed: never fetches context-excluded or credential-gated refs", async () => {
    const tree = await planTree(HUB, TASK, { maxDepth: 3, planOptions: { env: "prod" } });
    const reasons = Object.fromEntries(tree.notFollowed.map((r) => [r.id, r.reason]));
    expect(reasons["dev-only"]).toContain("excludes env 'prod'");
    expect(reasons["gated"]).toContain("needs github_pat");
    expect(tree.children.map((c) => c.refId)).toEqual(["child"]);
  });

  it("detects cycles instead of looping", async () => {
    const tree = await planTree(HUB, TASK, { maxDepth: 5 });
    const child = tree.children.find((c) => c.refId === "child");
    expect(child?.notFollowed.find((r) => r.id === "back-to-hub")?.reason).toContain("cycle");
    expect(child?.children).toHaveLength(0);
  });

  it("reports a dead ref as an error node without poisoning the parent", async () => {
    const tree = await planTree(HUB, TASK, { maxDepth: 1, planOptions: { env: "dev" } });
    // in env dev the 'gated' ref is still credential-gated, but 'dev-only' resolves
    // to the same child manifest — cycle-skipped after 'child' visits it first
    expect(tree.plan).toBeDefined();
    const errors = tree.children.filter((c) => c.error);
    for (const e of errors) expect(e.plan).toBeUndefined(); // fail-closed: no plan from a dead node
  });

  it("enforces requireSignature fail-closed on unsigned manifests", async () => {
    const tree = await planTree(HUB, TASK, { requireSignature: true });
    expect(tree.error).toContain("signature required");
    expect(tree.plan).toBeUndefined();
  });

  it("collects plans across the tree for synthesis", async () => {
    const tree = await planTree(HUB, TASK, { maxDepth: 1 });
    const all = plans(tree);
    expect(all.map((p) => p.manifest.project)).toEqual(["fed-hub", "fed-child"]);
    const loaded = [];
    for (const p of all) loaded.push(...(await loadPlannedUnits(p)).loaded);
    expect(loaded.map((u) => `${u.manifest}/${u.id}`)).toEqual(["fed-hub/hub-guide", "fed-child/child-deploy"]);
    expect(loaded[1].content).toContain("Child deploy runbook");
  });

  it("synthesize refuses gracefully when nothing is loadable", async () => {
    const tree = await planTree(HUB, "completely unrelated quantum topic", { maxDepth: 1 });
    const result = await synthesize(plans(tree));
    expect(result.unitsLoaded).toHaveLength(0);
    expect(result.answer).toContain("nothing to answer from");
  });
});

describe("tree-wide budget ceiling", () => {
  const PAID = "test/fixtures/paidfed/hub";
  const CAPS = { capabilities: { role: "agent", paymentMethods: ["free", "x402"] } };

  it("spend committed upstream counts against downstream manifests — one ceiling for the whole walk", async () => {
    const tree = await planTree(PAID, "compute award coverage", {
      maxDepth: 1,
      planOptions: { ...CAPS, budget: { amount: 0.3 } },
    });
    const [hub, wire] = plans(tree);
    // the hub buys its 0.25 exclusive…
    expect(hub.selected.map((u) => u.id)).toContain("hub-story");
    expect(hub.budget.projectedSpend).toBe(0.25);
    // …so the wire's 0.15 story no longer fits the SAME 0.3 ceiling
    const skip = wire.skipped.find((s) => s.id === "wire-story");
    expect(skip?.reason).toBe("over budget: 0.15 would exceed remaining 0.05 of 0.3 USDC");
    expect(wire.budget.alreadyCommitted).toBe(0.25);
    expect(wire.budget.remaining).toBe(0.05);
    // invariant: total projected spend across the tree never exceeds the ceiling
    const total = plans(tree).reduce((s, p) => s + (p.budget.projectedSpend ?? 0), 0);
    expect(total).toBeLessThanOrEqual(0.3);
  });

  it("a ceiling big enough for both is spent across both, with the ledger visible", async () => {
    const tree = await planTree(PAID, "compute award coverage", {
      maxDepth: 1,
      planOptions: { ...CAPS, budget: { amount: 0.5 } },
    });
    const [hub, wire] = plans(tree);
    expect(hub.selected.map((u) => u.id)).toContain("hub-story");
    expect(wire.selected.map((u) => u.id)).toContain("wire-story");
    expect(wire.budget.alreadyCommitted).toBe(0.25);
    expect(wire.budget.remaining).toBe(0.1);
  });
});
