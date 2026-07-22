//! Skill eligibility gate (#100/#105) — hand-authored, mirroring
//! `test/planner.test.ts` ("skill eligibility (#100)") and
//! `test/trace.test.ts` ("trace() — skill_eligibility gate (#100)").
//!
//! A `kind: skill` unit (a procedure, not a document) is invoke-eligible only
//! with an explicit `load_eligible: true` grant; without one it is soft-gated
//! (kept, `load_eligible: false`) in non-strict mode, or hard-rejected under
//! `--strict`. Not covered by the shared vector corpus outside the two
//! `skill-eligibility-*` vectors, so this file hand-checks composition with
//! supersession and the trace-level gate placement/verdicts directly.

use kcp_planner::planner::{CapabilitiesInput, PlanOptions};
use kcp_planner::{parse_manifest, plan, trace, GateName, GATE_ORDER};

const SKILLS: &str = r#"
project: skills-kb
version: 1.0.0
units:
  - id: deploy-skill
    path: skills/deploy.md
    intent: "How to deploy a release to production"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [deploy, release, production]
    action_scope:
      tools: [Bash]
      paths: ["scripts/**"]
      capabilities: [shell]
  - id: rollback-skill
    path: skills/rollback.md
    intent: "How to roll back a production deploy"
    kind: skill
    audience: [agent]
    triggers: [deploy, rollback, production]
  - id: old-deploy-skill
    path: skills/old-deploy.md
    intent: "Legacy deploy procedure, superseded"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [deploy, release, production]
    temporal: {superseded_by: deploy-skill}
"#;

const TASK: &str = "how do I deploy a release to production?";

fn agent_options(strict: bool) -> PlanOptions {
    PlanOptions {
        strict: if strict { Some(true) } else { None },
        capabilities: Some(CapabilitiesInput { role: Some("agent".to_string()), ..Default::default() }),
        ..Default::default()
    }
}

#[test]
fn loads_an_explicitly_eligible_skill() {
    let manifest = parse_manifest(SKILLS, Some("test")).expect("parse");
    let p = plan(&manifest, TASK, &agent_options(false));
    let skill = p.selected.iter().find(|u| u.id == "deploy-skill").expect("deploy-skill selected");
    assert!(skill.load_eligible);
}

#[test]
fn soft_gates_an_ungranted_skill_then_hard_rejects_under_strict() {
    let manifest = parse_manifest(SKILLS, Some("test")).expect("parse");

    // non-strict: soft-gated — still selected, load_eligible=false, exact reason present.
    let p = plan(&manifest, TASK, &agent_options(false));
    let skill = p.selected.iter().find(|u| u.id == "rollback-skill").expect("rollback-skill selected");
    assert!(!skill.load_eligible);
    assert!(
        skill.reasons.iter().any(|r| r == "kind: skill not invoke-eligible: no explicit eligibility grant"),
        "reasons: {:?}",
        skill.reasons
    );

    // strict: fail-closed — no longer selected, skipped with the exact reason.
    let strict = plan(&manifest, TASK, &agent_options(true));
    assert!(!strict.selected.iter().any(|u| u.id == "rollback-skill"));
    let skip = strict.skipped.iter().find(|s| s.id == "rollback-skill").expect("rollback-skill skipped");
    assert_eq!(skip.reason, "kind: skill not invoke-eligible: no explicit eligibility grant");
}

#[test]
fn eligible_but_superseded_skill_is_skipped_by_supersession() {
    // The gate composes with the others: an explicitly eligible skill whose
    // successor is active is still skipped by supersession, not selected.
    let manifest = parse_manifest(SKILLS, Some("test")).expect("parse");
    let p = plan(&manifest, TASK, &agent_options(false));
    assert!(!p.selected.iter().any(|u| u.id == "old-deploy-skill"));
    let skip = p.skipped.iter().find(|s| s.id == "old-deploy-skill").expect("old-deploy-skill skipped");
    assert_eq!(skip.reason, "superseded by deploy-skill (successor active)");
}

#[test]
fn gate_order_places_skill_eligibility_after_relevance_before_attestation() {
    let rel = GATE_ORDER.iter().position(|g| *g == GateName::Relevance).unwrap();
    let skill = GATE_ORDER.iter().position(|g| *g == GateName::SkillEligibility).unwrap();
    let att = GATE_ORDER.iter().position(|g| *g == GateName::Attestation).unwrap();
    assert_eq!(skill, rel + 1);
    assert_eq!(att, skill + 1);
}

#[test]
fn trace_eligible_skill_passes_the_gate_and_is_selected() {
    let manifest = parse_manifest(SKILLS, Some("test")).expect("parse");
    let t = trace(&manifest, TASK, &agent_options(false));
    let skill = t.units.iter().find(|u| u.id == "deploy-skill").expect("deploy-skill traced");
    assert_eq!(skill.outcome, "selected");
    let gate = skill.gates.iter().find(|g| g.gate == GateName::SkillEligibility).expect("gate present");
    assert!(gate.passed);
}

#[test]
fn trace_ineligible_skill_soft_passes_then_hard_rejects_under_strict() {
    let manifest = parse_manifest(SKILLS, Some("test")).expect("parse");

    // non-strict: soft-gated — still selected, gate passes but detail says load_eligible=false.
    let t = trace(&manifest, TASK, &agent_options(false));
    let soft = t.units.iter().find(|u| u.id == "rollback-skill").expect("rollback-skill traced");
    let soft_gate = soft.gates.iter().find(|g| g.gate == GateName::SkillEligibility).expect("gate present");
    assert!(soft_gate.passed);
    assert!(soft_gate.detail.contains("no explicit eligibility grant"));

    // strict: fail-closed at its own gate.
    let ts = trace(&manifest, TASK, &agent_options(true));
    let hard = ts.units.iter().find(|u| u.id == "rollback-skill").expect("rollback-skill traced");
    assert_eq!(hard.outcome, "skipped");
    assert_eq!(hard.rejected_by, Some(GateName::SkillEligibility));
    let hard_gate = hard.gates.iter().find(|g| g.gate == GateName::SkillEligibility).expect("gate present");
    assert!(!hard_gate.passed);
    assert_eq!(hard_gate.detail, "kind: skill not invoke-eligible: no explicit eligibility grant");
}
