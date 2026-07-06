// Decision trace tests — verify the gate cascade produces structured verdicts
// consistent with the canonical plan for every unit in a manifest.

import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan } from "../src/planner.js";
import { trace, GATE_ORDER } from "../src/trace.js";

const MANIFEST = `
kcp_version: "0.25"
project: test-kb
version: 1.0.0
trust:
  agent_requirements:
    require_attestation: true
    trusted_providers: ["internal-agents.acme.com"]
payment:
  default_tier: free
  methods:
    - type: free
rate_limits:
  default: {requests_per_minute: 10}
  authenticated: {requests_per_minute: 100}
manifests:
  - id: platform-prod
    url: "https://git.example.com/platform/knowledge.yaml"
    context: ["prod"]
    agent_identity: {required: true, credential_hint: github_pat, docs_url: "https://x/auth"}
  - id: platform-dev
    url: "https://git.example.com/platform/knowledge-dev.yaml"
    context: ["dev"]
units:
  - id: deploy-guide
    path: docs/deploy.md
    intent: "How are releases deployed to production?"
    scope: project
    audience: [agent, developer]
    triggers: [deploy, release, production]
  - id: human-notes
    path: notes.md
    intent: "Personal deploy notes"
    scope: project
    audience: [human]
    triggers: [deploy]
  - id: incident-runbook
    path: runbook.md
    intent: "Production incident response and deploy rollback runbook"
    scope: project
    audience: [agent]
    triggers: [incident, deploy, rollback]
    access: restricted
    auth_scope: "read:incident"
  - id: pricing-feed
    path: prices.md
    intent: "Live deploy pipeline metrics feed"
    scope: module
    audience: [agent]
    triggers: [deploy, metrics]
    payment:
      default_tier: metered
      methods:
        - type: x402
          currency: USDC
          price_per_request: "0.002"
  - id: old-policy
    path: old.md
    intent: "Legacy deploy policy"
    scope: project
    audience: [agent]
    triggers: [deploy, policy]
    temporal: {valid_until: "2020-01-01", superseded_by: new-policy}
  - id: sales-deck
    path: sales.md
    intent: "Quarterly sales overview"
    scope: project
    audience: [agent]
    triggers: [sales, revenue]
  - id: eu-datasheet
    path: eu.md
    intent: "EU data residency and GDPR datasheet"
    scope: project
    audience: [agent]
    triggers: [gdpr, residency]
    not_for: [medical advice]
`;

const CAPS = { capabilities: { role: "agent", paymentMethods: ["free", "x402"] } };

describe("trace()", () => {
  const m = parseManifest(MANIFEST, "test");

  it("produces a trace entry for every unit in the manifest", () => {
    const t = trace(m, "how do I deploy a release to production?", CAPS);
    expect(t.units.length).toBe(m.units.length);
    expect(t.plan.selected.length).toBeGreaterThan(0);
  });

  it("trace outcomes match the canonical plan exactly", () => {
    const t = trace(m, "how do I deploy a release to production?", CAPS);
    const selectedIds = new Set(t.plan.selected.map((u) => u.id));
    const skippedIds = new Set(t.plan.skipped.map((u) => u.id));
    for (const ut of t.units) {
      if (ut.outcome === "selected") {
        expect(selectedIds.has(ut.id), `${ut.id} traced as selected but not in plan.selected`).toBe(true);
      } else {
        expect(skippedIds.has(ut.id), `${ut.id} traced as skipped but not in plan.skipped`).toBe(true);
      }
    }
  });

  it("audience gate rejects human-only units", () => {
    const t = trace(m, "how do I deploy a release to production?", CAPS);
    const humanNotes = t.units.find((u) => u.id === "human-notes")!;
    expect(humanNotes.outcome).toBe("skipped");
    expect(humanNotes.rejectedBy).toBe("audience");
    expect(humanNotes.gates.length).toBe(1);
    expect(humanNotes.gates[0].gate).toBe("audience");
    expect(humanNotes.gates[0].passed).toBe(false);
  });

  it("temporal gate rejects expired units", () => {
    const t = trace(m, "how do I deploy a release to production?", CAPS);
    const old = t.units.find((u) => u.id === "old-policy")!;
    expect(old.outcome).toBe("skipped");
    expect(old.rejectedBy).toBe("temporal");
    expect(old.gates.find((g) => g.gate === "temporal")?.passed).toBe(false);
  });

  it("relevance gate rejects units with no task-term match", () => {
    const t = trace(m, "how do I deploy a release to production?", CAPS);
    const sales = t.units.find((u) => u.id === "sales-deck")!;
    expect(sales.outcome).toBe("skipped");
    expect(sales.rejectedBy).toBe("relevance");
  });

  it("selected units show all gates as passed (no rejectedBy)", () => {
    const t = trace(m, "how do I deploy a release to production?", CAPS);
    const deploy = t.units.find((u) => u.id === "deploy-guide")!;
    expect(deploy.outcome).toBe("selected");
    expect(deploy.rejectedBy).toBeUndefined();
    expect(deploy.gates.every((g) => g.passed)).toBe(true);
    expect(deploy.score).toBeGreaterThan(0);
  });

  it("gate summary counts are consistent", () => {
    const t = trace(m, "how do I deploy a release to production?", CAPS);
    for (const gs of t.gateSummary) {
      // passed + failed <= total units
      expect(gs.passed + gs.failed).toBeLessThanOrEqual(m.units.length);
    }
    // audience gate should evaluate every unit
    const audience = t.gateSummary.find((g) => g.gate === "audience")!;
    expect(audience.passed + audience.failed).toBe(m.units.length);
  });

  it("is deterministic: same inputs produce identical traces", () => {
    const a = trace(m, "deploy", CAPS);
    const b = trace(m, "deploy", CAPS);
    expect(a).toEqual(b);
  });

  it("records task terms", () => {
    const t = trace(m, "how do I deploy a release to production?", CAPS);
    expect(t.taskTerms).toContain("deploy");
    expect(t.taskTerms).toContain("release");
    expect(t.taskTerms).toContain("production");
    // stopwords should be stripped
    expect(t.taskTerms).not.toContain("how");
    expect(t.taskTerms).not.toContain("do");
  });
});

describe("trace() — budget and context gates", () => {
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
`;
  const m = parseManifest(SIZED, "test");

  it("context_budget gate rejects over-budget units with arithmetic", () => {
    const t = trace(m, "sovereign compute award grid", {
      capabilities: { role: "agent", paymentMethods: ["free"] },
      contextBudget: 4000,
    });
    const bMid = t.units.find((u) => u.id === "b-mid")!;
    const ctxGate = bMid.gates.find((g) => g.gate === "context_budget");
    expect(ctxGate?.passed).toBe(false);
    expect(ctxGate?.detail).toMatch(/exceed/);
    expect(bMid.rejectedBy).toBe("context_budget");
  });

  it("max_units gate rejects units beyond the cap", () => {
    const t = trace(m, "sovereign compute award grid", {
      capabilities: { role: "agent", paymentMethods: ["free"] },
      maxUnits: 1,
    });
    const selected = t.units.filter((u) => u.outcome === "selected");
    expect(selected.length).toBe(1);
    // The other units that passed relevance but didn't make the cut
    const maxReject = t.units.find((u) => u.rejectedBy === "max_units");
    expect(maxReject).toBeDefined();
  });
});

describe("trace() — money budget gate", () => {
  const PAID = `
kcp_version: "0.25"
project: paid
version: 1.0.0
units:
  - id: expensive
    path: e.md
    intent: "sovereign compute award"
    audience: [agent]
    triggers: [sovereign, compute, award]
    payment: { methods: [{type: x402, currency: USDC, price_per_request: "0.25"}] }
  - id: cheap
    path: c.md
    intent: "sovereign compute summary"
    audience: [agent]
    triggers: [sovereign, compute]
    payment: { methods: [{type: free}] }
`;
  const m = parseManifest(PAID, "test");

  it("money_budget gate rejects over-budget units", () => {
    const t = trace(m, "sovereign compute award", {
      capabilities: { role: "agent", paymentMethods: ["free", "x402"] },
      budget: { amount: 0.1 },
    });
    const expensive = t.units.find((u) => u.id === "expensive")!;
    const budgetGate = expensive.gates.find((g) => g.gate === "money_budget");
    expect(budgetGate?.passed).toBe(false);
    expect(budgetGate?.detail).toMatch(/exceed/);
    expect(expensive.rejectedBy).toBe("money_budget");
  });
});
