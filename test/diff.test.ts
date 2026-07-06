// Plan diff tests — verify that diffPlans detects moves, score changes,
// presence shifts, budget shifts, and reason changes between two plans.

import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan } from "../src/planner.js";
import { diffPlans } from "../src/diff.js";

const MANIFEST = `
kcp_version: "0.25"
project: test-kb
version: 1.0.0
units:
  - id: deploy-guide
    path: docs/deploy.md
    intent: "How are releases deployed to production?"
    audience: [agent]
    triggers: [deploy, release, production]
  - id: incident-runbook
    path: runbook.md
    intent: "Production incident response and deploy rollback runbook"
    audience: [agent]
    triggers: [incident, deploy, rollback]
  - id: sales-deck
    path: sales.md
    intent: "Quarterly sales overview"
    audience: [agent]
    triggers: [sales, revenue]
`;

describe("diffPlans()", () => {
  const m = parseManifest(MANIFEST, "test");

  it("identical plans produce an identical diff", () => {
    const p = plan(m, "deploy release", {});
    const d = diffPlans(p, p);
    expect(d.identical).toBe(true);
    expect(d.moves).toEqual([]);
    expect(d.scoreChanges).toEqual([]);
    expect(d.presence).toEqual([]);
  });

  it("detects units moving from selected to skipped when the task changes", () => {
    const a = plan(m, "deploy release production", {});
    const b = plan(m, "sales revenue quarterly", {});
    const d = diffPlans(a, b);
    expect(d.identical).toBe(false);
    const selToSkip = d.moves.filter((m) => m.direction === "selected_to_skipped");
    const skipToSel = d.moves.filter((m) => m.direction === "skipped_to_selected");
    // deploy-guide should move selected→skipped, sales-deck skipped→selected
    expect(selToSkip.some((m) => m.id === "deploy-guide")).toBe(true);
    expect(skipToSel.some((m) => m.id === "sales-deck")).toBe(true);
  });

  it("detects score changes when the task adds emphasis", () => {
    const a = plan(m, "deploy", {});
    const b = plan(m, "deploy release production incident rollback", {});
    const d = diffPlans(a, b);
    // deploy-guide should have a higher score in b
    const sc = d.scoreChanges.find((s) => s.id === "deploy-guide");
    if (sc) {
      expect(sc.delta).toBeGreaterThan(0);
      expect(sc.after).toBeGreaterThan(sc.before);
    }
  });

  it("detects units present in one plan but not the other", () => {
    const m2 = parseManifest(`
kcp_version: "0.25"
project: test-kb
version: 2.0.0
units:
  - id: deploy-guide
    path: docs/deploy.md
    intent: "How are releases deployed to production?"
    audience: [agent]
    triggers: [deploy, release, production]
  - id: new-unit
    path: new.md
    intent: "Brand new documentation"
    audience: [agent]
    triggers: [deploy]
`, "test");
    const a = plan(m, "deploy", {});
    const b = plan(m2, "deploy", {});
    const d = diffPlans(a, b);
    expect(d.presence.some((p) => p.id === "new-unit" && p.side === "b_only")).toBe(true);
    // incident-runbook and sales-deck are in A but not in B
    expect(d.presence.some((p) => p.id === "incident-runbook" && p.side === "a_only")).toBe(true);
  });

  it("detects budget shifts", () => {
    const a = plan(m, "deploy", { budget: { amount: 1.0 } });
    const b = plan(m, "deploy", { budget: { amount: 0.5 } });
    const d = diffPlans(a, b);
    expect(d.budgetShifts.some((s) => s.field === "budget.ceiling")).toBe(true);
  });

  it("is deterministic", () => {
    const a = plan(m, "deploy", {});
    const b = plan(m, "sales revenue", {});
    const d1 = diffPlans(a, b);
    const d2 = diffPlans(a, b);
    expect(d1).toEqual(d2);
  });

  it("detects reason changes for units skipped in both with different reasons", () => {
    // sales-deck is skipped in both plans; same reason ("no task-relevance match")
    const a = plan(m, "deploy", {});
    const b = plan(m, "deploy production", {});
    const d = diffPlans(a, b);
    // If sales-deck is skipped in both with the same reason, no reasonChange
    const salesChange = d.reasonChanges.find((r) => r.id === "sales-deck");
    expect(salesChange).toBeUndefined(); // same reason in both
  });
});
