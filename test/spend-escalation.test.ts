import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan } from "../src/planner.js";
import { trace } from "../src/trace.js";

// action_scope.spend as a per-step budget ceiling (§4.3a.1) and escalation-trigger
// evaluation during planning (§3.14, RFC-0026).
//
// The planner already parses action_scope.spend (max_spend / allowed_vendors) and each
// step's escalation triggers, and surfaces action_scope onto the plan — but it never
// *enforces* either. A proposed spend threaded through planning could exceed a governed
// step's declared max_spend, or name a vendor the step forbids, and still be selected; a
// step declaring `requires_approval` was offered with nothing recording that a grant is
// owed before enactment. These tests pin both gaps, fail-closed, parallel to the §3.13
// authority-ceiling gate.
describe("action_scope.spend per-step ceiling (§4.3a.1)", () => {
  const M = `
kcp_version: "0.30"
project: spend-kb
version: 1.0.0
units:
  - id: pay-vendor
    path: skills/pay.md
    intent: "How do I settle the monthly compute invoice with the model vendor?"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [settle, invoice, compute, vendor, pay]
    action_scope:
      tools: [Bash]
      spend:
        max_spend: 25
        allowed_vendors: [anthropic, openai]
        currency: USD
  - id: settle-playbook
    path: playbooks/settle.md
    intent: "How do we settle the monthly compute invoice end to end?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [settle, invoice, compute, vendor, pay]
    steps:
      - id: pay
        uses: pay-vendor
        authority_level: commit
`;
  const m = parseManifest(M, "test");
  const TASK = "how do we settle the monthly compute invoice with the vendor?";
  const AGENT = { capabilities: { role: "agent" } };

  it("refuses a step whose proposed spend exceeds the target's max_spend, fail-closed under strict", () => {
    const p = plan(m, TASK, { strict: true, spend: { amount: 100, currency: "USD" }, ...AGENT });
    expect(p.selected.some((u) => u.id === "settle-playbook")).toBe(false);
    const skip = p.skipped.find((s) => s.id === "settle-playbook");
    expect(skip).toBeDefined();
    expect(skip?.reason).toContain("pay");
    expect(skip?.reason).toContain("§4.3a.1");
    expect(skip?.spend?.maxSpend).toBe(25);
  });

  it("soft-gates the same over-budget step in non-strict mode (loadEligible=false, limit surfaced)", () => {
    const p = plan(m, TASK, { spend: { amount: 100, currency: "USD" }, ...AGENT });
    const pb = p.selected.find((u) => u.id === "settle-playbook");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(false);
    expect(pb?.reasons.join(" ")).toContain("§4.3a.1");
    expect(pb?.spend?.maxSpend).toBe(25);
    expect(pb?.spend?.bindingSource).toContain("pay");
  });

  it("refuses a proposed vendor outside the step's allowed_vendors", () => {
    const p = plan(m, TASK, { strict: true, spend: { amount: 5, vendor: "sketchy-labs", currency: "USD" }, ...AGENT });
    expect(p.selected.some((u) => u.id === "settle-playbook")).toBe(false);
    const skip = p.skipped.find((s) => s.id === "settle-playbook");
    expect(skip?.reason).toContain("sketchy-labs");
    expect(skip?.reason).toContain("§4.3a.1");
  });

  it("admits a proposed spend within the ceiling and an allowed vendor, surfacing the limit", () => {
    const p = plan(m, TASK, { strict: true, spend: { amount: 10, vendor: "anthropic", currency: "USD" }, ...AGENT });
    const pb = p.selected.find((u) => u.id === "settle-playbook");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(true);
    expect(pb?.spend?.maxSpend).toBe(25);
  });

  it("keeps existing behavior when no spend is proposed (no gating, no marker)", () => {
    const p = plan(m, TASK, { strict: true, ...AGENT });
    const pb = p.selected.find((u) => u.id === "settle-playbook");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(true);
    expect(pb?.spend).toBeUndefined();
  });

  it("the decision trace keeps outcome parity when a spend is threaded (audit parity)", () => {
    const opts = { strict: true, spend: { amount: 100, currency: "USD" }, ...AGENT };
    const t = trace(m, TASK, opts);
    const p = plan(m, TASK, opts);
    for (const ut of t.units) {
      expect(ut.outcome === "selected").toBe(p.selected.some((s) => s.id === ut.id));
    }
  });
});

describe("escalation-trigger evaluation → grant_request marker (§3.14)", () => {
  const M = `
kcp_version: "0.30"
project: escalation-kb
version: 1.0.0
units:
  - id: run-tests
    path: skills/run.md
    intent: "How do I run the release suite before promoting?"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [promote, release, suite, ship]
    action_scope: {tools: [Bash]}
  - id: promote-playbook
    path: playbooks/promote.md
    intent: "How do we promote a verified build to production?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [promote, release, production, ship]
    steps:
      - id: verify
        uses: run-tests
        authority_level: observe
      - id: ship
        uses: run-tests
        authority_level: observe
        escalation: requires_approval
`;
  const m = parseManifest(M, "test");
  const TASK = "how do we promote a verified build to production?";
  const AGENT = { capabilities: { role: "agent" } };

  it("emits a grant_request marker for a step declaring an escalation trigger, without auto-approving", () => {
    const p = plan(m, TASK, AGENT);
    const pb = p.selected.find((u) => u.id === "promote-playbook");
    expect(pb).toBeDefined();
    // Escalation is a runtime approval requirement, not a planning refusal — the step is
    // still offered, but the plan records that a grant is owed before enactment.
    expect(pb?.loadEligible).toBe(true);
    const gr = pb?.grantRequests?.find((g) => g.step === "ship");
    expect(gr).toBeDefined();
    expect(gr?.triggers).toContain("requires_approval");
  });

  it("emits no grant_request when no step declares an escalation trigger", () => {
    const clean = parseManifest(
      M.replace("        escalation: requires_approval\n", ""),
      "test",
    );
    const p = plan(clean, TASK, AGENT);
    const pb = p.selected.find((u) => u.id === "promote-playbook");
    expect(pb).toBeDefined();
    expect(pb?.grantRequests).toBeUndefined();
  });
});
