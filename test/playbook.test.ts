import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan } from "../src/planner.js";
import { trace } from "../src/trace.js";

// kind: playbook as a governed unit (#118) — KCP v0.29, §4.3b / RFC-0027.
//
// A playbook is an ordered composition of units, governed per step, reaching up to
// `commit` authority. The skill_eligibility gate fail-closes `kind: skill` because a
// governed procedure *acts* where a document only informs. A playbook is strictly more
// dangerous by that same reasoning: it composes several procedures, and RFC-0027's own
// framing is that the composition is what reaches commit.
//
// Before this fix the gate tested `unit.kind === "skill"` literally, so a playbook took
// the else branch and passed as "not a skill" — the planner refused the skill and handed
// over the playbook that invokes it. These tests pin that the composition is held to at
// least the standard of its parts.
describe("playbook eligibility (#118)", () => {
  const PLAYBOOKS = `
kcp_version: "0.29"
project: playbook-kb
version: 1.0.0
units:
  - id: rotate-key
    path: skills/rotate-key.md
    intent: "How do I rotate the production signing key?"
    kind: skill
    audience: [agent]
    triggers: [rotate, signing, key]
    action_scope:
      tools: [Bash]
      paths: ["**"]
  - id: rotate-key-playbook
    path: playbooks/rotate.md
    intent: "How do I rotate the production signing key end to end?"
    kind: playbook
    audience: [agent]
    triggers: [rotate, signing, key]
    steps:
      - id: verify
        uses: rotate-key
        authority_level: observe
        success_condition: "current key fingerprint reported"
        on_failure: abort
      - id: rotate
        uses: rotate-key
        depends_on: [verify]
        authority_level: commit
        escalation: requires_approval
        on_failure: escalate
  # Granted, and its step's target is granted too. Both are required as of KCP v0.30
  # §4.3c: a grant on a playbook does not compose to the units its steps name, so this
  # fixture needed granted-target adding when #123 landed — the composition was
  # previously "granted" while naming a unit that was not.
  - id: granted-target
    path: skills/granted-target.md
    intent: "How do I rotate the production signing key, granted?"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [rotate, signing, key]
    action_scope:
      tools: [Bash]
      paths: ["infra/**"]
  - id: granted-playbook
    path: playbooks/granted.md
    intent: "How do I rotate the production signing key with approval?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [rotate, signing, key]
    steps:
      - id: rotate
        uses: granted-target
        authority_level: commit
`;
  const m = parseManifest(PLAYBOOKS, "test");
  const TASK = "how do I rotate the production signing key?";
  const AGENT = { capabilities: { role: "agent" } };

  it("soft-gates a playbook with no eligibility grant, exactly as it does a skill", () => {
    const p = plan(m, TASK, AGENT);
    const pb = p.selected.find((u) => u.id === "rotate-key-playbook");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(false);
    expect(pb?.reasons.join(" ")).toContain("not invoke-eligible");
  });

  it("fail-closes an ungranted playbook under strict", () => {
    const p = plan(m, TASK, { strict: true, ...AGENT });
    expect(p.selected.some((u) => u.id === "rotate-key-playbook")).toBe(false);
    const skip = p.skipped.find((s) => s.id === "rotate-key-playbook");
    expect(skip?.reason).toContain("not invoke-eligible");
  });

  it("loads a playbook with an explicit eligibility grant", () => {
    const p = plan(m, TASK, AGENT);
    const pb = p.selected.find((u) => u.id === "granted-playbook");
    expect(pb).toBeDefined();
    expect(pb?.loadEligible).toBe(true);
  });

  it("never offers a playbook while refusing the skill it composes", () => {
    // The defect this issue was filed for, stated as an invariant rather than a case.
    // A composition that reaches an agent while its own components are withheld hands
    // over authority by the back door — the agent has the procedure but not the parts,
    // and the parts were withheld deliberately.
    const p = plan(m, TASK, { strict: true, ...AGENT });
    const skillOffered = p.selected.some((u) => u.id === "rotate-key");
    const playbookOffered = p.selected.some((u) => u.id === "rotate-key-playbook");
    expect(skillOffered).toBe(false);
    expect(playbookOffered).toBe(false);
  });

  it("attributes the skip to the eligibility gate, not the generic strict gate", () => {
    // Matches the skill contract: the trace outcome must equal the canonical plan and
    // name the gate that actually decided, or an operator debugging a refusal is told
    // "strict mode" and learns nothing.
    const p = plan(m, TASK, { strict: true, ...AGENT });
    const skip = p.skipped.find((s) => s.id === "rotate-key-playbook");
    expect(skip?.reason).not.toBe("strict mode");
    expect(skip?.reason).toContain("kind: playbook");
  });
});

// §4.3b: the composition itself must survive parsing. Before this fix `client.ts` built
// units with no `steps` field at all, so a playbook reached the 14-gate cascade looking
// like a knowledge document with no procedure — safe, per §4.3a's unknown-kind rule, but
// it means nothing downstream can reason about the composition.
describe("playbook steps parsing (#118)", () => {
  const M = `
kcp_version: "0.29"
project: steps-kb
version: 1.0.0
units:
  - id: run-tests
    path: skills/run.md
    intent: "How do I run the suite?"
    kind: skill
    audience: [agent]
  - id: promote
    path: playbooks/promote.md
    intent: "How do we promote a verified build?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    steps:
      - id: verify
        uses: run-tests
        authority_level: observe
        success_condition: "zero failures reported by the suite"
        on_failure: abort
      - id: ship
        uses: run-tests
        depends_on: [verify]
        authority_level: commit
        escalation: requires_approval
        timeout: PT10M
        on_failure: escalate
`;
  const m = parseManifest(M, "test");
  const pb = m.units.find((u) => u.id === "promote");

  it("parses steps onto the playbook unit", () => {
    expect(pb?.steps).toBeDefined();
    expect(pb?.steps?.map((s) => s.id)).toEqual(["verify", "ship"]);
  });

  it("parses every declared step field", () => {
    const ship = pb?.steps?.find((s) => s.id === "ship");
    expect(ship?.uses).toBe("run-tests");
    expect(ship?.depends_on).toEqual(["verify"]);
    expect(ship?.authority_level).toBe("commit");
    expect(ship?.escalation).toEqual(["requires_approval"]);
    expect(ship?.timeout).toBe("PT10M");
    expect(ship?.on_failure).toBe("escalate");
  });

  it("normalises a bare escalation string to a list", () => {
    // §4.3b: the triggers are disjunctive, so a scalar and a one-element list mean the
    // same thing. Normalising at parse time means no consumer handles both shapes.
    const ship = pb?.steps?.find((s) => s.id === "ship");
    expect(Array.isArray(ship?.escalation)).toBe(true);
  });

  it("leaves steps undefined on a unit that declares none", () => {
    // "declares no steps" and "declares an empty composition" are different statements
    // and must stay distinguishable downstream.
    expect(m.units.find((u) => u.id === "run-tests")?.steps).toBeUndefined();
  });

  it("tolerates a malformed steps block without failing the parse", () => {
    // A manifest is untrusted input. A bad steps block must degrade to "declares no
    // steps" — which fails closed at the eligibility gate — not take down the manifest.
    const bad = parseManifest(
      `project: x\nversion: 1.0.0\nunits:\n  - id: p\n    path: p.md\n    intent: "i"\n    kind: playbook\n    audience: [agent]\n    steps: "not-a-list"\n`,
      "test",
    );
    expect(bad.units[0]?.steps).toBeUndefined();
    expect(bad.units[0]?.id).toBe("p");
  });
});

// The decision trace reimplements the cascade to emit per-gate verdicts, so it holds a
// SECOND copy of the eligibility condition. Mutation-testing the fix showed why that
// matters: reverting trace.ts alone left all 468 tests passing, because nothing asserted
// on the trace's verdict for a playbook. The trace is the compliance artifact — a trace
// that disagrees with the plan does not merely lose a test, it produces an audit record
// that says the agent was refused something it was in fact offered.
describe("playbook eligibility in the decision trace (#118)", () => {
  const M = `
kcp_version: "0.29"
project: trace-kb
version: 1.0.0
units:
  - id: rotate-key
    path: skills/rotate-key.md
    intent: "How do I rotate the production signing key?"
    kind: skill
    audience: [agent]
    triggers: [rotate, signing, key]
  - id: rotate-playbook
    path: playbooks/rotate.md
    intent: "How do I rotate the production signing key end to end?"
    kind: playbook
    audience: [agent]
    triggers: [rotate, signing, key]
    steps:
      - id: rotate
        uses: rotate-key
        authority_level: commit
`;
  const m = parseManifest(M, "test");
  const TASK = "how do I rotate the production signing key?";
  const CAPS = { capabilities: { role: "agent" } };

  it("records a skill_eligibility verdict naming kind: playbook", () => {
    const t = trace(m, TASK, CAPS);
    const pb = t.units.find((u) => u.id === "rotate-playbook")!;
    const gate = pb.gates.find((g) => g.gate === "skill_eligibility")!;
    expect(gate).toBeDefined();
    expect(gate.detail).toContain("kind: playbook");
    expect(gate.detail).toContain("not invoke-eligible");
  });

  it("trace outcome matches the canonical plan for a playbook, under strict", () => {
    // The invariant the whole trace exists to hold. If these diverge the compliance
    // artifact is fiction.
    const opts = { strict: true, ...CAPS };
    const t = trace(m, TASK, opts);
    const p = plan(m, TASK, opts);
    for (const ut of t.units) {
      const inPlan = p.selected.some((s) => s.id === ut.id);
      expect(ut.outcome === "selected").toBe(inPlan);
    }
  });

  it("attributes the strict rejection to skill_eligibility, not the strict gate", () => {
    const t = trace(m, TASK, { strict: true, ...CAPS });
    const pb = t.units.find((u) => u.id === "rotate-playbook")!;
    expect(pb.outcome).toBe("skipped");
    const failed = pb.gates.find((g) => !g.passed)!;
    expect(failed.gate).toBe("skill_eligibility");
  });
});

// Eligibility does not compose (#123) — KCP v0.30, §4.3c / RFC-0028.
//
// A grant on a playbook does not reach the units its steps name. The v0.30 validator
// makes a granted playbook whose step `uses` an ungranted unit a manifest ERROR; the
// planner offered it anyway, handing an agent a procedure whose first step invokes
// something it may not invoke.
//
// Same failure class as #118, direction reversed: that was an ungranted playbook being
// offered, this is a granted playbook whose parts are not.
describe("eligibility does not compose (#123)", () => {
  const M = `
kcp_version: "0.30"
project: compose-kb
version: 1.0.0
units:
  - id: ungranted-skill
    path: skills/a.md
    intent: "How do I promote a verified build to production?"
    kind: skill
    audience: [agent]
    triggers: [promote, release, production]
    action_scope: {tools: [Bash]}
  - id: granted-skill
    path: skills/b.md
    intent: "How do I promote a verified build to production?"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [promote, release, production]
    action_scope: {tools: [Bash]}
  - id: leaky-playbook
    path: playbooks/leaky.md
    intent: "How do we promote a verified build to production?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [promote, release, production]
    steps:
      - id: go
        uses: ungranted-skill
        authority_level: commit
  - id: sound-playbook
    path: playbooks/sound.md
    intent: "How do we promote a verified build to production safely?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [promote, release, production]
    steps:
      - id: go
        uses: granted-skill
        authority_level: commit
`;
  const m = parseManifest(M, "test");
  const TASK = "promote a verified build to production";
  const AGENT = { capabilities: { role: "agent" } };

  it("does not offer a granted playbook whose step uses an ungranted unit", () => {
    // The defect. A grant on the composition is not a grant on the parts, so this
    // playbook cannot be enacted as written and must not reach an agent.
    const p = plan(m, TASK, { strict: true, ...AGENT });
    expect(p.selected.some((u) => u.id === "leaky-playbook")).toBe(false);
  });

  it("says why, naming the step and the unit that is not eligible", () => {
    const p = plan(m, TASK, { strict: true, ...AGENT });
    const skip = p.skipped.find((s) => s.id === "leaky-playbook");
    expect(skip?.reason).toMatch(/ungranted-skill/);
    expect(skip?.reason).toMatch(/not invoke-eligible|does not compose/);
  });

  it("still offers a playbook whose steps are all eligible", () => {
    // The rule must not swallow the valid case: a composition whose parts are granted
    // is exactly what §4.3c permits.
    const p = plan(m, TASK, { strict: true, ...AGENT });
    expect(p.selected.some((u) => u.id === "sound-playbook")).toBe(true);
  });

  it("the trace agrees with the plan", () => {
    // #119's lesson: trace.ts reimplements the cascade, so a divergence emits an audit
    // record claiming an agent was refused something it was in fact offered.
    const opts = { strict: true, ...AGENT };
    const t = trace(m, TASK, opts);
    const p = plan(m, TASK, opts);
    for (const ut of t.units) {
      expect(ut.outcome === "selected").toBe(p.selected.some((s) => s.id === ut.id));
    }
  });

  it("attributes the refusal to a gate, with the reason", () => {
    // Outcome equality alone is too weak, and mutation testing proved it: removing the
    // trace's compose check still skipped the playbook — via no gate at all, leaving
    // `rejectedBy: undefined`. The trace agreed with the plan and could not say why,
    // which is an audit record that cannot be traced back to a rule. That is the exact
    // failure #119 was filed for, so assert the attribution rather than the verdict.
    const t = trace(m, TASK, { strict: true, ...AGENT });
    const leaky = t.units.find((u) => u.id === "leaky-playbook")!;
    expect(leaky.outcome).toBe("skipped");
    expect(leaky.rejectedBy).toBe("skill_eligibility");
    const failed = leaky.gates.find((g) => !g.passed);
    expect(failed?.detail).toMatch(/ungranted-skill/);
    expect(failed?.detail).toMatch(/does not compose/);
  });
});
