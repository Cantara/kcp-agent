import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan } from "../src/planner.js";

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

describe("plan()", () => {
  const m = parseManifest(MANIFEST, "test");

  it("selects task-relevant, agent-audience, in-time units and ranks by score", () => {
    const p = plan(m, "how do I deploy a release to production?", {
      capabilities: { role: "agent", paymentMethods: ["free", "x402"] },
    });
    const ids = p.selected.map((u) => u.id);
    expect(ids).toContain("deploy-guide");
    expect(ids[0]).toBe("deploy-guide"); // strongest intent+trigger match ranks first
    // human-only, expired, and irrelevant units are skipped with reasons
    const skipById = Object.fromEntries(p.skipped.map((s) => [s.id, s.reason]));
    expect(skipById["human-notes"]).toMatch(/audience/);
    expect(skipById["old-policy"]).toMatch(/expired.*superseded/);
    expect(skipById["sales-deck"]).toMatch(/no task-relevance/);
  });

  it("not_for negative targeting skips a unit its publisher scoped out (spec §4)", () => {
    const covered = plan(m, "gdpr data residency", { capabilities: { role: "agent" } });
    expect(covered.selected.map((u) => u.id)).toContain("eu-datasheet");
    const excluded = plan(m, "gdpr medical advice", { capabilities: { role: "agent" } });
    expect(excluded.selected.map((u) => u.id)).not.toContain("eu-datasheet");
    const skip = excluded.skipped.find((s) => s.id === "eu-datasheet");
    expect(skip?.reason).toBe("not_for declares it does not serve 'medical advice'");
  });

  it("gates a restricted unit when the agent cannot attest", () => {
    const p = plan(m, "deploy incident rollback runbook", {
      capabilities: { role: "agent", paymentMethods: ["free"] },
    });
    const runbook = p.selected.find((u) => u.id === "incident-runbook");
    expect(runbook?.loadEligible).toBe(false);
    expect(runbook?.reasons.join(" ")).toMatch(/attestation/);
    expect(p.trust.agentCanAttest).toBe(false);
  });

  it("allows the restricted unit once the agent presents a trusted provider", () => {
    const p = plan(m, "deploy incident rollback runbook", {
      capabilities: { role: "agent", paymentMethods: ["free"], credentials: ["api_key"], attestationProvider: "internal-agents.acme.com" },
    });
    expect(p.trust.agentCanAttest).toBe(true);
    const runbook = p.selected.find((u) => u.id === "incident-runbook");
    expect(runbook?.loadEligible).toBe(true);
  });

  it("plans x402 payment and marks it unaffordable without the method", () => {
    const withX402 = plan(m, "live deploy metrics feed", { capabilities: { role: "agent", paymentMethods: ["free", "x402"] } });
    const feed = withX402.selected.find((u) => u.id === "pricing-feed");
    expect(feed?.payment.method).toBe("x402");
    expect(feed?.payment.cost).toBe("0.002 USDC/request");
    expect(feed?.loadEligible).toBe(true);
    expect(withX402.budget.perRequestCosts.some((c) => c.unit === "pricing-feed")).toBe(true);

    const noX402 = plan(m, "live deploy metrics feed", { capabilities: { role: "agent", paymentMethods: ["free"] } });
    const feed2 = noX402.selected.find((u) => u.id === "pricing-feed");
    expect(feed2?.payment.affordable).toBe(false);
    expect(feed2?.loadEligible).toBe(false);
  });

  it("selects federation sub-manifests by env context and flags credential needs", () => {
    const prod = plan(m, "deploy", { env: "prod", capabilities: { role: "agent" } });
    const fed = Object.fromEntries(prod.federation.map((f) => [f.id, f]));
    expect(fed["platform-prod"].selected).toBe(true);
    expect(fed["platform-prod"].credentialNeeded).toBe("github_pat");
    expect(fed["platform-dev"].selected).toBe(false);
  });

  it("fails closed on context-tagged refs when the agent declares no env", () => {
    const p = plan(m, "deploy", { capabilities: { role: "agent" } });
    const fed = Object.fromEntries(p.federation.map((f) => [f.id, f]));
    expect(fed["platform-prod"].selected).toBe(false);
    expect(fed["platform-dev"].selected).toBe(false);
    expect(fed["platform-prod"].reason).toContain("fail-closed");
  });

  it("context-free refs stay eligible without a declared env", () => {
    const m2 = parseManifest(`
project: p
version: 1.0.0
units: []
manifests:
  - id: open
    url: "https://example.com/knowledge.yaml"
`);
    const p = plan(m2, "anything", {});
    expect(p.federation[0].selected).toBe(true);
    expect(p.federation[0].reason).toBe("eligible");
  });

  it("resolves the rate-limit tier from agent credentials", () => {
    const anon = plan(m, "deploy", { capabilities: { role: "agent" } });
    expect(anon.budget.rateTier).toBe("default");
    expect(anon.budget.requestsPerMinute).toBe(10);
    const authed = plan(m, "deploy", { capabilities: { role: "agent", credentials: ["api_key"] } });
    expect(authed.budget.rateTier).toBe("authenticated");
    expect(authed.budget.requestsPerMinute).toBe(100);
  });

  it("strict mode drops non-eligible units instead of listing them", () => {
    const p = plan(m, "deploy incident rollback runbook metrics feed", {
      strict: true,
      capabilities: { role: "agent", paymentMethods: ["free"] },
    });
    expect(p.selected.every((u) => u.loadEligible)).toBe(true);
    expect(p.skipped.some((s) => s.id === "incident-runbook")).toBe(true);
  });
});

// Supersession precedence over temporal overlap (spec §4.22, v0.25.1; #7):
// a unit whose declared superseded_by successor is itself selectable
// SHOULD NOT be selected.
const TRANSITION = `
kcp_version: "0.25"
project: transition
version: 1.0.0
units:
  - id: chipfab-rumour
    path: stories/rumour.md
    intent: "Rumour round-up: who is favourite for the compute award?"
    audience: [agent]
    triggers: [compute, award]
    temporal:
      valid_from: "2026-06-28"
      valid_until: "2026-07-05"
      superseded_by: chipfab-exclusive
  - id: chipfab-exclusive
    path: stories/exclusive.md
    intent: "Exclusive: the compute award decision"
    audience: [agent]
    triggers: [compute, award]
    temporal:
      valid_from: "2026-07-05"
  - id: orphan-note
    path: notes/orphan.md
    intent: "Compute award note pointing at a successor that does not exist"
    audience: [agent]
    triggers: [compute, award]
    temporal:
      superseded_by: no-such-unit
`;

describe("supersession precedence (spec §4.22, #7)", () => {
  const m = parseManifest(TRANSITION, "test");
  const TASK = "compute award";

  it("skips the predecessor on the overlap day when the successor is active", () => {
    const p = plan(m, TASK, { asOf: "2026-07-05" });
    expect(p.selected.map((u) => u.id)).toContain("chipfab-exclusive");
    expect(p.selected.map((u) => u.id)).not.toContain("chipfab-rumour");
    const skip = p.skipped.find((s) => s.id === "chipfab-rumour");
    expect(skip?.reason).toBe("superseded by chipfab-exclusive (successor active)");
  });

  it("keeps the predecessor while the successor is still in the future", () => {
    const p = plan(m, TASK, { asOf: "2026-07-04" });
    expect(p.selected.map((u) => u.id)).toContain("chipfab-rumour");
    const skip = p.skipped.find((s) => s.id === "chipfab-exclusive");
    expect(skip?.reason).toMatch(/not active until 2026-07-05/);
  });

  it("keeps a unit whose declared successor does not exist", () => {
    const p = plan(m, TASK, { asOf: "2026-07-05" });
    expect(p.selected.map((u) => u.id)).toContain("orphan-note");
  });

  it("keeps the predecessor when the successor is not audience-eligible for this role", () => {
    const m2 = parseManifest(`
project: p
version: 1.0.0
units:
  - id: old
    path: old.md
    intent: "compute award summary"
    audience: [agent]
    triggers: [compute]
    temporal: {superseded_by: new}
  - id: new
    path: new.md
    intent: "compute award summary, humans only"
    audience: [human]
    triggers: [compute]
`);
    const p = plan(m2, "compute award", { asOf: "2026-07-05" });
    expect(p.selected.map((u) => u.id)).toContain("old");
  });
});

// Red-team follow-ups: unicode vocabulary and the trigger-stuffing bound.

describe("unicode task terms", () => {
  const NORSK = parseManifest(`
project: norsk
version: 1.0.0
units:
  - id: omstilling
    path: omstilling.md
    intent: "Grønn omstilling av kraftnettet"
    audience: [agent]
    triggers: [grønn, kraftnett]
`);

  it("scores non-ASCII vocabulary as whole terms — 'grønn' matches, not its ASCII shards", () => {
    const p = plan(NORSK, "grønn energi", {});
    const hit = p.selected.find((u) => u.id === "omstilling");
    expect(hit).toBeDefined();
    expect(hit?.reasons.join(" ")).toMatch(/triggers match/);
  });

  it("a task in the publisher's language finds the intent too", () => {
    const p = plan(NORSK, "omstilling av kraftnettet", {});
    expect(p.selected[0]?.id).toBe("omstilling");
  });
});

describe("trigger stuffing captures rank, never gates (characterization)", () => {
  it("a stuffed restricted unit may outrank an honest one but stays load-ineligible", () => {
    const m2 = parseManifest(`
project: stuffing
version: 1.0.0
trust:
  agent_requirements:
    require_attestation: true
    trusted_providers: [good.example]
units:
  - id: honest
    path: honest.md
    intent: "How to deploy a release"
    audience: [agent]
    triggers: [deploy]
  - id: stuffed
    path: stuffed.md
    intent: "deploy deploy release release production rollout ship"
    audience: [agent]
    triggers: [deploy, release, production, rollout, ship, pipeline]
    access: restricted
`);
    const p = plan(m2, "how to deploy a release to production", { capabilities: { role: "agent" } });
    // Documented limitation: lexical stuffing can capture the *ranking*…
    expect(p.selected[0]?.id).toBe("stuffed");
    // …but score is not authority: every gate is indifferent to it.
    expect(p.selected.find((u) => u.id === "stuffed")?.loadEligible).toBe(false);
    expect(p.selected.find((u) => u.id === "honest")?.loadEligible).toBe(true);
  });
});
