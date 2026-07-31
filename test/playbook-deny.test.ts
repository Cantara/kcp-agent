import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan, effectiveDeniesToken, resolveDenyScope } from "../src/planner.js";
import { trace } from "../src/trace.js";
import { validateManifest } from "../src/validate.js";

// RFC-0030 / KCP 0.32: `action_scope.deny` on a `kind: playbook` unit is NORMATIVE for
// enactment — a blanket prohibition over every step, inline steps included, while the
// rest of the playbook's action_scope envelope stays declarative. The effective denylist
// for a step is the UNION per dimension of the playbook's deny and the used skill's deny:
// a token matching EITHER source is refused, overriding any allow, deny-first, fail-closed
// (§4.3b). And a deny is never grantable: a deny-hit is refused finally and raises a
// notify-only prohibited-attempt marker — an auditable event, not a request for
// permission. No grant/approval/escalation outcome may enact a denied action.
const M = `
kcp_version: "0.32"
project: deletion-kb
version: 1.0.0
units:
  - id: document-agent
    path: skills/document.md
    intent: "How to identify and document records slated for deletion"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [delete, deletion, records, gdpr]
    action_scope:
      tools: [Read, Grep]
      paths: ["records/**"]
  - id: deletion-agent
    path: skills/delete.md
    intent: "How to delete expired records under retention policy"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [delete, deletion, records, gdpr]
    action_scope:
      tools: [Bash, transfer_ownership]
      paths: ["records/**"]
      deny:
        tools: [publish_external]
        capabilities: [network]
  - id: gdpr-deletion
    path: playbooks/gdpr-deletion.md
    intent: "How do we run a GDPR deletion request end to end?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [delete, deletion, records, gdpr]
    action_scope:
      deny:
        tools: [transfer_ownership]
        paths: ["legal/hold/**"]
        capabilities: [network]
    steps:
      - id: identify
        uses: document-agent
        authority_level: observe
      - id: erase
        uses: deletion-agent
        authority_level: commit
`;

const TASK = "how do we run a gdpr deletion of expired records?";
const AGENT = { capabilities: { role: "agent" } };
const m = parseManifest(M, "test");
const playbook = m.units.find((u) => u.id === "gdpr-deletion");
const skill = m.units.find((u) => u.id === "deletion-agent");

describe("playbook-level action_scope.deny parses (§4.3b, RFC-0030)", () => {
  it("parses deny onto a kind: playbook unit through the generic action_scope path", () => {
    expect(playbook?.action_scope?.deny?.tools).toEqual(["transfer_ownership"]);
    expect(playbook?.action_scope?.deny?.paths).toEqual(["legal/hold/**"]);
    expect(playbook?.action_scope?.deny?.capabilities).toEqual(["network"]);
  });

  it("accepts a kcp_version 0.32 manifest without a version finding", () => {
    expect(m.kcp_version).toBe("0.32");
    const findings = validateManifest(m);
    expect(findings.filter((f) => f.message.includes("kcp_version"))).toEqual([]);
  });
});

describe("effectiveDeniesToken: union of deny sources (§4.3b, RFC-0030)", () => {
  it("denies a token matched by either source, and both", () => {
    const scopes = [playbook?.action_scope, skill?.action_scope];
    expect(effectiveDeniesToken(scopes, "tools", "transfer_ownership")).toBe(true); // playbook only
    expect(effectiveDeniesToken(scopes, "tools", "publish_external")).toBe(true); // skill only
    expect(effectiveDeniesToken(scopes, "capabilities", "network")).toBe(true); // both
    expect(effectiveDeniesToken(scopes, "tools", "Bash")).toBe(false); // neither
    expect(effectiveDeniesToken([undefined, undefined], "tools", "Bash")).toBe(false);
  });
});

describe("planner deny gate: union, binding source, deny overrides allow (§4.3b)", () => {
  it("refuses a tool the skill allows but the playbook denies, naming the playbook as binding source", () => {
    // transfer_ownership is on deletion-agent's ALLOWLIST — the playbook deny still wins.
    const p = plan(m, TASK, { strict: true, action: { tool: "transfer_ownership" }, ...AGENT });
    expect(p.selected.some((u) => u.id === "gdpr-deletion")).toBe(false);
    const skip = p.skipped.find((s) => s.id === "gdpr-deletion");
    expect(skip).toBeDefined();
    expect(skip?.reason).toContain("playbook action_scope.deny");
    expect(skip?.reason).toContain("§4.3b");
    expect(skip?.prohibitedAttempts?.[0]?.bindingSource).toBe("playbook action_scope.deny");
  });

  it("refuses a token only the used skill denies, naming the skill as binding source", () => {
    const p = plan(m, TASK, { strict: true, action: { tool: "publish_external" }, ...AGENT });
    const skip = p.skipped.find((s) => s.id === "gdpr-deletion");
    expect(skip).toBeDefined();
    expect(skip?.reason).toContain("skill 'deletion-agent' action_scope.deny");
    expect(skip?.prohibitedAttempts?.[0]?.bindingSource).toBe("skill 'deletion-agent' action_scope.deny");
  });

  it("names both sources when both match on the adjudicated step", () => {
    // The playbook AND the erase step's skill both deny `network`. Adjudicated on the
    // erase step directly (the gate reports the first matching step in step order, like
    // resolveSpendScope — the identify step matches on the playbook source alone).
    const erased = { ...playbook!, steps: playbook!.steps!.filter((s) => s.id === "erase") };
    const res = resolveDenyScope(erased, m, { capability: "network" });
    expect(res.prohibited?.step).toBe("erase");
    expect(res.prohibited?.bindingSource).toBe(
      "playbook action_scope.deny and skill 'deletion-agent' action_scope.deny",
    );
  });

  it("refuses a denied path (legal hold) on any step", () => {
    const p = plan(m, TASK, { strict: true, action: { path: "legal/hold/**" }, ...AGENT });
    expect(p.selected.some((u) => u.id === "gdpr-deletion")).toBe(false);
    const skip = p.skipped.find((s) => s.id === "gdpr-deletion");
    expect(skip?.prohibitedAttempts?.[0]?.dimension).toBe("paths");
    expect(skip?.prohibitedAttempts?.[0]?.token).toBe("legal/hold/**");
  });

  it("soft-gates in non-strict mode: still listed, loadEligible=false, marker surfaced", () => {
    const p = plan(m, TASK, { action: { tool: "transfer_ownership" }, ...AGENT });
    const pb = p.selected.find((u) => u.id === "gdpr-deletion");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(false);
    expect(pb?.reasons.join(" ")).toContain("§4.3b");
    expect(pb?.prohibitedAttempts?.length).toBe(1);
  });

  it("admits a proposed action no deny source matches (allow side stays declarative)", () => {
    const p = plan(m, TASK, { strict: true, action: { tool: "Bash" }, ...AGENT });
    const pb = p.selected.find((u) => u.id === "gdpr-deletion");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(true);
    expect(pb?.prohibitedAttempts).toBeUndefined();
  });

  it("keeps existing behavior when no action is proposed (no gating, no marker)", () => {
    const p = plan(m, TASK, { strict: true, ...AGENT });
    const pb = p.selected.find((u) => u.id === "gdpr-deletion");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(true);
    expect(pb?.prohibitedAttempts).toBeUndefined();
  });

  it("gates a bare skill's own deny the same way (§4.3a composes unchanged)", () => {
    const p = plan(m, "how do I delete expired records under retention policy?", {
      strict: true, action: { capability: "network" }, ...AGENT,
    });
    const skip = p.skipped.find((s) => s.id === "deletion-agent");
    expect(skip).toBeDefined();
    expect(skip?.prohibitedAttempts?.[0]?.bindingSource).toBe("skill 'deletion-agent' action_scope.deny");
  });

  it("the decision trace keeps outcome parity when an action is threaded (audit parity)", () => {
    const opts = { strict: true, action: { tool: "transfer_ownership" }, ...AGENT };
    const t = trace(m, TASK, opts);
    const p = plan(m, TASK, opts);
    for (const ut of t.units) {
      expect(ut.outcome === "selected").toBe(p.selected.some((s) => s.id === ut.id));
    }
    const pbTrace = t.units.find((u) => u.id === "gdpr-deletion");
    expect(pbTrace?.gates.map((g) => g.detail).join(" ")).toContain("§4.3b");
  });
});

describe("a playbook deny binds inline (action) steps (§4.3b, RFC-0030)", () => {
  // An inline step is scope-unbounded on the allow axis — the playbook deny is the
  // first hard edge it has ever had, enforceable at the orchestration gate.
  const INLINE = `
kcp_version: "0.32"
project: inline-kb
version: 1.0.0
units:
  - id: cleanup
    path: playbooks/cleanup.md
    intent: "How do we clean up stale workspace records?"
    kind: playbook
    audience: [agent]
    triggers: [cleanup, stale, workspace, records]
    action_scope:
      deny:
        paths: ["legal/hold/**"]
    steps:
      - id: sweep
        action: "remove stale records from the workspace"
`;
  const im = parseManifest(INLINE, "test");

  it("refuses a denied path on an inline step, playbook as binding source", () => {
    const res = resolveDenyScope(im.units[0], im, { path: "legal/hold/**" });
    expect(res.prohibited).toBeDefined();
    expect(res.prohibited?.step).toBe("sweep");
    expect(res.prohibited?.bindingSource).toBe("playbook action_scope.deny");
  });
});

describe("a deny is never grantable (§4.3b, RFC-0030)", () => {
  // The denied step also declares `escalation: requires_approval`. Under RFC-0030 the
  // deny-hit is refused finally: what the plan raises is a prohibited-attempt marker,
  // NOT a grant request — no approval outcome may enact the denied action.
  const E = `
kcp_version: "0.32"
project: grant-kb
version: 1.0.0
units:
  - id: deletion-agent
    path: skills/delete.md
    intent: "How to delete expired records under retention policy"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [delete, deletion, records, gdpr]
    action_scope:
      tools: [Bash]
  - id: gdpr-deletion
    path: playbooks/gdpr-deletion.md
    intent: "How do we run a GDPR deletion request end to end?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [delete, deletion, records, gdpr]
    action_scope:
      deny:
        paths: ["legal/hold/**"]
    steps:
      - id: erase
        uses: deletion-agent
        authority_level: commit
        escalation: requires_approval
`;
  const em = parseManifest(E, "test");

  it("a deny-hit raises a prohibited-attempt marker, not a grant request, for the denied step", () => {
    const p = plan(em, TASK, { action: { path: "legal/hold/**" }, ...AGENT });
    const pb = p.selected.find((u) => u.id === "gdpr-deletion");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(false);
    const attempt = pb?.prohibitedAttempts?.[0];
    expect(attempt?.step).toBe("erase");
    // Notify-only: the marker says so, in so many words.
    expect(attempt?.note).toContain("not grantable");
    // No grant request is emitted for the denied step — there is nothing to grant.
    expect(pb?.grantRequests?.some((g) => g.step === "erase")).not.toBe(true);
  });

  it("without a deny-hit the same step's escalation trigger still owes a grant (§3.14 unchanged)", () => {
    const p = plan(em, TASK, { action: { path: "records/2024/**" }, ...AGENT });
    const pb = p.selected.find((u) => u.id === "gdpr-deletion");
    expect(pb?.loadEligible).toBe(true);
    expect(pb?.grantRequests?.some((g) => g.step === "erase")).toBe(true);
  });
});

describe("validator: playbook deny lints (§4.3b, RFC-0030)", () => {
  it("warns on an empty playbook deny (prohibits nothing)", () => {
    const v = parseManifest(
      M.replace(/      deny:\n        tools: \[transfer_ownership\]\n        paths: \["legal\/hold\/\*\*"\]\n        capabilities: \[network\]\n/, "      deny: {}\n"),
      "test",
    );
    const findings = validateManifest(v);
    expect(findings.some((f) => f.level === "warning" && f.where === "unit 'gdpr-deletion'" && f.message.includes("prohibits nothing"))).toBe(true);
  });

  it("warns when a step is self-nullified: every token its skill allows is in the effective deny", () => {
    const NULLIFIED = `
kcp_version: "0.32"
project: nullified-kb
version: 1.0.0
units:
  - id: mover
    path: skills/move.md
    intent: "How to transfer record ownership"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [transfer, ownership]
    action_scope:
      tools: [transfer_ownership]
  - id: handover
    path: playbooks/handover.md
    intent: "How do we hand records over to a new owner?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [transfer, ownership, handover]
    action_scope:
      deny:
        tools: [transfer_ownership]
    steps:
      - id: move
        uses: mover
        authority_level: commit
`;
    const findings = validateManifest(parseManifest(NULLIFIED, "test"));
    expect(findings.some((f) =>
      f.level === "warning" && f.where === "unit 'handover'" && f.message.includes("self-nullified"),
    )).toBe(true);
  });
});
