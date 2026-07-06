// Deterministic context-window planning (#33). Tokens are the scarce resource
// when feeding a model; --context-budget names it. Mirrors the money budget
// exactly: greedy by score, take a unit if it fits the ceiling, else skip it
// with the arithmetic in the reason and keep walking (a smaller lower-scored
// unit still gets its chance — no knapsack cleverness). A unit's size comes
// from declared `size_tokens` (faithful) or `bytes/4` (estimate, flagged).

import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan } from "../src/planner.js";

// Scores order by trigger-match count: A(4) > B(3) > c/d/e(2, by id).
const SIZED = `
kcp_version: "0.25"
project: sized
version: 1.0.0
units:
  - id: a-lead
    path: a.md
    intent: "lead"
    audience: [agent]
    triggers: [sovereign, compute, award, grid]
    size_tokens: 3000
  - id: b-mid
    path: b.md
    intent: "mid"
    audience: [agent]
    triggers: [sovereign, compute, award]
    size_tokens: 1500
  - id: c-small
    path: c.md
    intent: "small"
    audience: [agent]
    triggers: [sovereign, compute]
    size_tokens: 400
  - id: d-bytes
    path: d.md
    intent: "byte-declared only"
    audience: [agent]
    triggers: [sovereign, compute]
    bytes: 2000
  - id: e-sizeless
    path: e.md
    intent: "no size at all"
    audience: [agent]
    triggers: [sovereign, compute]
`;

const CAPS = { capabilities: { role: "agent", paymentMethods: ["free", "x402"] } };
const TASK = "sovereign compute award grid";

describe("--context-budget — greedy by score, fail-closed on the token ceiling", () => {
  const m = parseManifest(SIZED, "test");

  it("skips an over-budget unit with the token arithmetic, and a smaller unit still fits", () => {
    const p = plan(m, TASK, { ...CAPS, contextBudget: 4000 });
    const ids = p.selected.filter((u) => !p.skipped.some((s) => s.id === u.id)).map((u) => u.id);
    // a-lead (3000) fits; b-mid (1500) would blow 4000 → skipped; c-small (400) still fits
    expect(ids).toContain("a-lead");
    expect(ids).toContain("c-small");
    const skip = p.skipped.find((s) => s.id === "b-mid");
    expect(skip?.reason).toBe("over context budget: 1,500 tokens would exceed remaining 1,000 of 4,000");
  });

  it("uses declared size_tokens exactly, and estimates bytes/4 (flagged approximate)", () => {
    // Under 4000: a-lead(3000) + c-small(400) + d-bytes(2000 bytes → 500 est) = 3900.
    const p = plan(m, TASK, { ...CAPS, contextBudget: 4000 });
    expect(p.selected.some((u) => u.id === "d-bytes")).toBe(true);
    expect(p.context.approximate).toBe(true); // the bytes/4 estimate was used
    // A tighter ceiling that selects only declared-token units is not approximate.
    const exact = plan(m, TASK, { ...CAPS, contextBudget: 3000 });
    expect(exact.selected.some((u) => u.id === "d-bytes")).toBe(false);
    expect(exact.context.approximate).toBe(false);
  });

  it("admits an undeclared-size unit but counts it unmeasured; --strict excludes it", () => {
    const lax = plan(m, TASK, { ...CAPS, contextBudget: 4000 });
    expect(lax.selected.some((u) => u.id === "e-sizeless")).toBe(true);
    expect(lax.context.unmeasured).toBe(1);
    expect(lax.warnings.join(" ")).toMatch(/unmeasured|lower bound/);

    const strict = plan(m, TASK, { ...CAPS, contextBudget: 4000, strict: true });
    const skip = strict.skipped.find((s) => s.id === "e-sizeless");
    expect(skip?.reason).toMatch(/size undeclared/);
  });

  it("reports ceiling, projected tokens, and remaining in the context plan", () => {
    const p = plan(m, TASK, { ...CAPS, contextBudget: 4000 });
    // selected measured tokens: a-lead 3000 + c-small 400 + d-bytes 500 = 3900
    expect(p.context.ceiling).toBe(4000);
    expect(p.context.projectedTokens).toBe(3900);
    expect(p.context.remaining).toBe(100);
    expect(p.context.unmeasured).toBe(1);
  });

  it("without a context budget, selection is unchanged and no ceiling is reported", () => {
    const p = plan(m, TASK, CAPS);
    expect(p.selected.map((u) => u.id)).toContain("b-mid");
    expect(p.context.ceiling).toBeUndefined();
  });
});

describe("--context-budget composes with the money --budget: a unit must fit both", () => {
  const PAID = `
kcp_version: "0.25"
project: paid
version: 1.0.0
units:
  - id: cheap-big
    path: cb.md
    intent: "cheap but token-heavy"
    audience: [agent]
    triggers: [sovereign, compute, award, grid]
    size_tokens: 5000
    payment: { methods: [{type: x402, currency: USDC, price_per_request: "0.05"}] }
  - id: pricey-small
    path: ps.md
    intent: "small but expensive"
    audience: [agent]
    triggers: [sovereign, compute, award]
    size_tokens: 200
    payment: { methods: [{type: x402, currency: USDC, price_per_request: "0.90"}] }
`;
  const m = parseManifest(PAID, "test");

  it("fits money but blown by tokens → skipped for context", () => {
    const p = plan(m, TASK, { ...CAPS, budget: { amount: 1 }, contextBudget: 1000 });
    const skip = p.skipped.find((s) => s.id === "cheap-big");
    expect(skip?.reason).toMatch(/over context budget: 5,000 tokens/);
  });

  it("fits tokens but blown by money → skipped for budget", () => {
    const p = plan(m, TASK, { ...CAPS, budget: { amount: 0.5 }, contextBudget: 10000 });
    const skip = p.skipped.find((s) => s.id === "pricey-small");
    expect(skip?.reason).toMatch(/over budget: 0.9 would exceed/);
  });
});
