// Economics: x402 as the access ritual (#2) and deterministic budget planning (#3).
// Modeled on the Fjordwire scenario from "Selling News to Robots".

import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan } from "../src/planner.js";

const FJORDWIRE = `
kcp_version: "0.25"
project: fjordwire
version: 1.0.0
units:
  - id: chipfab-exclusive
    path: stories/chipfab-exclusive.md
    intent: "Exclusive: sovereign compute award decision and the winning bid"
    audience: [agent]
    triggers: [sovereign, compute, award, exclusive]
    access: restricted
    payment:
      methods:
        - {type: x402, currency: USDC, price_per_request: "0.25"}
  - id: datacenter-power
    path: feeds/datacenter-power.md
    intent: "Live Nordic datacenter power-grid capacity feed for the compute award"
    audience: [agent]
    triggers: [datacenter, power grid, capacity, compute]
    payment:
      methods:
        - {type: x402, currency: USDC, price_per_request: "0.05"}
  - id: subsea-cable-feature
    path: stories/subsea-cable-feature.md
    intent: "Feature: the subsea cable route that decided the compute award"
    audience: [agent]
    triggers: [subsea, cable, compute]
    access: restricted
    payment:
      methods:
        - {type: x402, currency: USDC, price_per_request: "0.15"}
  - id: free-summary
    path: stories/summary.md
    intent: "Free summary of the sovereign compute award"
    audience: [agent]
    triggers: [sovereign, compute, award]
    payment:
      methods:
        - {type: free}
`;

const CAPS = { capabilities: { role: "agent", paymentMethods: ["free", "x402"] } };
const TASK = "sovereign compute award";

describe("x402 settles access (#2)", () => {
  const m = parseManifest(FJORDWIRE, "test");

  it("a supported x402 method satisfies access:restricted without credentials", () => {
    const p = plan(m, TASK, CAPS);
    const exclusive = p.selected.find((u) => u.id === "chipfab-exclusive");
    expect(exclusive?.loadEligible).toBe(true);
    expect(exclusive?.reasons.join(" ")).toMatch(/satisfied by x402/);
  });

  it("still gates restricted units when the agent cannot pay per-request", () => {
    const p = plan(m, TASK, { capabilities: { role: "agent", paymentMethods: ["free"] } });
    const exclusive = p.selected.find((u) => u.id === "chipfab-exclusive");
    expect(exclusive?.loadEligible).toBe(false);
  });

  it("keeps the credential gate when a credential exists but payment does not", () => {
    // restricted + free-only payment: paying is not an option, credentials still rule
    const m2 = parseManifest(`
project: p
version: 1.0.0
units:
  - id: locked
    path: a.md
    intent: "compute award internals"
    audience: [agent]
    triggers: [compute]
    access: restricted
`);
    const p = plan(m2, TASK, CAPS);
    const locked = p.selected.find((u) => u.id === "locked");
    expect(locked?.loadEligible).toBe(false);
    expect(locked?.reasons.join(" ")).toMatch(/holds no credentials/);
  });
});

describe("--budget deterministic spend planning (#3)", () => {
  const m = parseManifest(FJORDWIRE, "test");

  it("buys by score until the ceiling, skips what would blow it, keeps walking", () => {
    const p = plan(m, TASK, { ...CAPS, budget: { amount: 0.4 } });
    const ids = p.selected.map((u) => u.id);
    // exclusive (0.25) fits; power feed (0.05) fits; cable feature (0.15) would
    // exceed the remaining 0.10 — skipped with the arithmetic; free unit always fits
    expect(ids).toContain("chipfab-exclusive");
    expect(ids).toContain("datacenter-power");
    expect(ids).toContain("free-summary");
    expect(ids).not.toContain("subsea-cable-feature");
    const skip = p.skipped.find((s) => s.id === "subsea-cable-feature");
    expect(skip?.reason).toMatch(/over budget: 0.15 would exceed remaining/);
    expect(skip?.reason).toMatch(/of 0.4 USDC/);
  });

  it("reports ceiling, projected spend, and remaining in the budget plan", () => {
    const p = plan(m, TASK, { ...CAPS, budget: { amount: 0.4 } });
    expect(p.budget.ceiling).toBe(0.4);
    expect(p.budget.projectedSpend).toBe(0.3);
    expect(p.budget.remaining).toBe(0.1);
    expect(p.budget.currency).toBe("USDC");
  });

  it("free units are unaffected by a zero budget", () => {
    const p = plan(m, TASK, { ...CAPS, budget: { amount: 0 } });
    expect(p.selected.map((u) => u.id)).toEqual(["free-summary"]);
    expect(p.budget.projectedSpend).toBe(0);
  });

  it("skips units priced in a different currency than the budget", () => {
    const p = plan(m, TASK, { ...CAPS, budget: { amount: 100, currency: "NOK" } });
    const skip = p.skipped.find((s) => s.id === "chipfab-exclusive");
    expect(skip?.reason).toMatch(/budget is in NOK/);
  });

  it("without a budget, selection is unchanged and no ceiling is reported", () => {
    const p = plan(m, TASK, CAPS);
    expect(p.selected.map((u) => u.id)).toContain("subsea-cable-feature");
    expect(p.budget.ceiling).toBeUndefined();
  });
});
