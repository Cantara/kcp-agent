import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan } from "../src/planner.js";
import { trace } from "../src/trace.js";

// Authority ceiling enforcement (§3.13, v0.27) — the effective-authority gate.
//
// A `kind: playbook` composes steps, each declaring the authority level it acts at
// (observe < explain < suggest < prepare < commit). The playbook's own `authority_level`
// is a ceiling over every step, and the enacting agent/tenant may carry a lower grant
// ceiling still. The effective authority is the MINIMUM ('laveste av') across those
// sources — a source can only *lower* it, never raise it.
//
// The planner parsed `authority_level` but never gated on it: a granted playbook could
// carry a `commit` step under a `prepare` ceiling and be selected without an authority
// check. These tests pin the gate: a step demanding more than the resolved ceiling makes
// the composition unenactable as written, fail-closed, with the binding source named.
describe("authority ceiling enforcement (§3.13)", () => {
  const M = `
kcp_version: "0.30"
project: authority-kb
version: 1.0.0
authority_level_scale: [observe, explain, suggest, prepare, commit]
units:
  - id: read-status
    path: skills/read.md
    intent: "How do I read the deployment status before promoting?"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [promote, deploy, production, status]
    action_scope: {tools: [Read]}
  - id: do-promote
    path: skills/promote.md
    intent: "How do I promote the verified build to production?"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [promote, deploy, production, ship]
    action_scope: {tools: [Bash]}
  - id: capped-playbook
    path: playbooks/capped.md
    intent: "How do we promote a verified build to production under a prepare ceiling?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [promote, deploy, production, ship]
    authority_level: prepare
    steps:
      - id: check
        uses: read-status
        authority_level: observe
      - id: ship
        uses: do-promote
        authority_level: commit
  - id: within-ceiling-playbook
    path: playbooks/within.md
    intent: "How do we promote a verified build to production, fully?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [promote, deploy, production, ship]
    authority_level: commit
    steps:
      - id: check
        uses: read-status
        authority_level: observe
      - id: ship
        uses: do-promote
        authority_level: commit
  - id: unbounded-playbook
    path: playbooks/unbounded.md
    intent: "How do we promote a verified build to production, uncapped?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [promote, deploy, production, ship]
    steps:
      - id: ship
        uses: do-promote
        authority_level: commit
`;
  const m = parseManifest(M, "test");
  const TASK = "how do we promote a verified build to production?";
  const AGENT = { capabilities: { role: "agent" } };

  it("parses the playbook-level authority_level ceiling onto the unit", () => {
    const pb = m.units.find((u) => u.id === "capped-playbook");
    expect(pb?.authority_level).toBe("prepare");
  });

  it("parses the manifest authority_level_scale", () => {
    expect(m.authority_level_scale).toEqual(["observe", "explain", "suggest", "prepare", "commit"]);
  });

  it("fail-closes a playbook whose step exceeds the playbook-level ceiling under strict", () => {
    const p = plan(m, TASK, { strict: true, ...AGENT });
    expect(p.selected.some((u) => u.id === "capped-playbook")).toBe(false);
    const skip = p.skipped.find((s) => s.id === "capped-playbook");
    expect(skip).toBeDefined();
    expect(skip?.reason).toContain("commit");
    expect(skip?.reason).toContain("prepare");
    expect(skip?.reason).toContain("§3.13");
  });

  it("names the binding source on the skipped entry so it is auditable", () => {
    const p = plan(m, TASK, { strict: true, ...AGENT });
    const skip = p.skipped.find((s) => s.id === "capped-playbook");
    expect(skip?.reason).toContain("playbook authority_level");
    expect(skip?.authority?.bindingSource).toBe("playbook authority_level");
    expect(skip?.authority?.ceiling).toBe("prepare");
  });

  it("soft-gates the same playbook in non-strict mode (loadEligible=false, not silently selected)", () => {
    const p = plan(m, TASK, AGENT);
    const pb = p.selected.find((u) => u.id === "capped-playbook");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(false);
    expect(pb?.reasons.join(" ")).toContain("above the resolved ceiling");
  });

  it("admits a playbook whose steps are all at or below the ceiling, surfacing the resolved level", () => {
    const p = plan(m, TASK, { strict: true, ...AGENT });
    const pb = p.selected.find((u) => u.id === "within-ceiling-playbook");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(true);
    expect(pb?.authority?.ceiling).toBe("commit");
    expect(pb?.authority?.bindingSource).toBe("playbook authority_level");
  });

  it("keeps existing behavior for a playbook that declares no ceiling and no grant applies", () => {
    const p = plan(m, TASK, { strict: true, ...AGENT });
    const pb = p.selected.find((u) => u.id === "unbounded-playbook");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(true);
    expect(pb?.authority).toBeUndefined();
  });

  it("enforces an agent/tenant grantCeiling as a ceiling source (multi-source minimum)", () => {
    // The unbounded playbook has no playbook-level ceiling, but the enacting agent's
    // grant does — a commit step is refused once the agent grant caps at 'suggest'.
    const p = plan(m, TASK, { strict: true, grantCeiling: "suggest", ...AGENT });
    expect(p.selected.some((u) => u.id === "unbounded-playbook")).toBe(false);
    const skip = p.skipped.find((s) => s.id === "unbounded-playbook");
    expect(skip?.reason).toContain("agent grant_ceiling");
    expect(skip?.authority?.bindingSource).toBe("agent grant_ceiling");
    expect(skip?.authority?.ceiling).toBe("suggest");
  });

  it("binds to the lowest source when playbook ceiling and agent grant disagree", () => {
    // within-ceiling-playbook declares a commit ceiling; a 'prepare' agent grant is lower,
    // so it — not the playbook ceiling — binds, and the commit step is refused.
    const p = plan(m, TASK, { strict: true, grantCeiling: "prepare", ...AGENT });
    const skip = p.skipped.find((s) => s.id === "within-ceiling-playbook");
    expect(skip).toBeDefined();
    expect(skip?.authority?.ceiling).toBe("prepare");
    expect(skip?.authority?.bindingSource).toBe("agent grant_ceiling");
  });

  it("the decision trace attributes the refusal to a gate and names the step (audit parity)", () => {
    const opts = { strict: true, ...AGENT };
    const t = trace(m, TASK, opts);
    const p = plan(m, TASK, opts);
    // outcome parity across every unit
    for (const ut of t.units) {
      expect(ut.outcome === "selected").toBe(p.selected.some((s) => s.id === ut.id));
    }
    const capped = t.units.find((u) => u.id === "capped-playbook")!;
    expect(capped.outcome).toBe("skipped");
    expect(capped.rejectedBy).toBe("skill_eligibility");
    const failed = capped.gates.find((g) => !g.passed);
    expect(failed?.detail).toContain("ship");
    expect(failed?.detail).toContain("§3.13");
  });
});
