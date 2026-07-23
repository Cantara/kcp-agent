package no.cantara.kcp.planner;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Optional;

import no.cantara.kcp.planner.model.Manifest;
import no.cantara.kcp.planner.model.Unit;
import no.cantara.kcp.planner.trace.DecisionTrace;
import no.cantara.kcp.planner.trace.GateName;
import no.cantara.kcp.planner.trace.GateVerdict;
import no.cantara.kcp.planner.trace.UnitTrace;

import org.junit.jupiter.api.Test;

/**
 * Procedures/skills as governed units (#100): a {@code kind: skill} unit fails
 * closed — load/invoke-eligible only with an explicit {@code load_eligible: true}
 * grant. The gate composes with the others: a superseded skill is still skipped
 * by supersession, not by skill_eligibility. Mirrors the "skill eligibility (#100)"
 * describe block in {@code test/planner.test.ts} and the
 * "trace() — skill_eligibility gate (#100)" describe block in {@code test/trace.test.ts}.
 */
class SkillEligibilityTest {

    private static final String SKILLS = """
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
                  spend:
                    max_spend: 25
                    allowed_vendors: [anthropic, openai]
                    currency: USD
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
            """;

    private static final String TASK = "how do I deploy a release to production?";

    private static PlanOptions agentOptions() {
        return PlanOptions.builder().role("agent").build();
    }

    private static PlanOptions agentStrictOptions() {
        return PlanOptions.builder().role("agent").strict(true).build();
    }

    @Test
    void loadsAnExplicitlyEligibleSkill() {
        Manifest m = ManifestParser.parse(SKILLS, "test");
        AgentPlan p = KcpPlanner.plan(m, TASK, agentOptions());

        Optional<PlannedUnit> skill = p.selected().stream().filter(u -> u.id().equals("deploy-skill")).findFirst();
        assertTrue(skill.isPresent());
        assertTrue(skill.get().loadEligible());
    }

    @Test
    void softGatesASkillWithNoEligibilityGrantThenFailClosedUnderStrict() {
        Manifest m = ManifestParser.parse(SKILLS, "test");
        AgentPlan p = KcpPlanner.plan(m, TASK, agentOptions());

        Optional<PlannedUnit> skill = p.selected().stream().filter(u -> u.id().equals("rollback-skill")).findFirst();
        assertTrue(skill.isPresent());
        assertFalse(skill.get().loadEligible());
        assertTrue(String.join(" ", skill.get().reasons())
                .contains("kind: skill not invoke-eligible: no explicit eligibility grant"));

        // strict mode converts the soft-gate to a skip
        AgentPlan strict = KcpPlanner.plan(m, TASK, agentStrictOptions());
        assertFalse(strict.selected().stream().anyMatch(u -> u.id().equals("rollback-skill")));
        SkippedUnit skip = strict.skipped().stream().filter(s -> s.id().equals("rollback-skill")).findFirst().orElse(null);
        assertNotNull(skip);
        assertEquals("kind: skill not invoke-eligible: no explicit eligibility grant", skip.reason());
    }

    @Test
    void parsesActionScopeOntoTheEligibleSkill() {
        Manifest m = ManifestParser.parse(SKILLS, "test");
        Unit skill = m.units().stream().filter(u -> u.id().equals("deploy-skill")).findFirst().orElse(null);
        assertNotNull(skill);
        assertEquals(List.of("Bash"), skill.actionScope().tools());
        assertEquals(List.of("scripts/**"), skill.actionScope().paths());
        assertEquals(List.of("shell"), skill.actionScope().capabilities());
        assertEquals(25.0, skill.actionScope().spend().maxSpend());
        assertEquals(List.of("anthropic", "openai"), skill.actionScope().spend().allowedVendors());
        assertEquals("USD", skill.actionScope().spend().currency());
    }

    @Test
    void maxSpendPreservesFractionalCurrencyAmounts() {
        // A Long-typed maxSpend would silently truncate 4.99 to 4, loosening the
        // declared ceiling. The TS reference (number) and Rust port (f64) both
        // preserve the fraction — the Java port must match.
        Manifest m = ManifestParser.parse("""
                project: p
                version: 1.0.0
                units:
                  - id: metered-skill
                    path: skills/metered.md
                    intent: "A skill with a fractional spend ceiling"
                    kind: skill
                    load_eligible: true
                    audience: [agent]
                    triggers: [scope]
                    action_scope:
                      tools: [Bash]
                      spend:
                        max_spend: 4.99
                        currency: USD
                """, "test");
        Unit skill = m.units().stream().filter(u -> u.id().equals("metered-skill")).findFirst().orElse(null);
        assertNotNull(skill);
        assertEquals(4.99, skill.actionScope().spend().maxSpend());
    }

    @Test
    void anEligibleButSupersededSkillIsStillSkippedBySupersession() {
        Manifest m = ManifestParser.parse(SKILLS, "test");
        AgentPlan p = KcpPlanner.plan(m, TASK, agentOptions());

        assertFalse(p.selected().stream().anyMatch(u -> u.id().equals("old-deploy-skill")));
        SkippedUnit skip = p.skipped().stream().filter(s -> s.id().equals("old-deploy-skill")).findFirst().orElse(null);
        assertNotNull(skip);
        assertEquals("superseded by deploy-skill (successor active)", skip.reason());
    }

    // --- trace() coverage (test/trace.test.ts, "trace() — skill_eligibility gate (#100)") ---

    private static final String TRACE_SKILLS = """
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
              - id: rollback-skill
                path: skills/rollback.md
                intent: "How to roll back a production deploy"
                kind: skill
                audience: [agent]
                triggers: [deploy, rollback, production]
            """;

    @Test
    void placesSkillEligibilityAfterRelevanceAndBeforeAttestationInGateOrder() {
        int rel = GateName.ORDER.indexOf(GateName.RELEVANCE);
        int skill = GateName.ORDER.indexOf(GateName.SKILL_ELIGIBILITY);
        int att = GateName.ORDER.indexOf(GateName.ATTESTATION);
        assertEquals(rel + 1, skill);
        assertEquals(skill + 1, att);
    }

    @Test
    void anEligibleSkillPassesSkillEligibilityAndIsSelected() {
        Manifest m = ManifestParser.parse(TRACE_SKILLS, "test");
        DecisionTrace t = KcpPlanner.trace(m, TASK, agentOptions());

        UnitTrace skill = t.units().stream().filter(u -> u.id().equals("deploy-skill")).findFirst().orElse(null);
        assertNotNull(skill);
        assertEquals("selected", skill.outcome());
        GateVerdict gate = skill.gates().stream().filter(g -> g.gate() == GateName.SKILL_ELIGIBILITY).findFirst().orElse(null);
        assertNotNull(gate);
        assertTrue(gate.passed());
    }

    @Test
    void anIneligibleSkillSoftPassesButFailsClosedUnderStrictWithRejectedBySkillEligibility() {
        Manifest m = ManifestParser.parse(TRACE_SKILLS, "test");

        // non-strict: soft-gated, still selected, loadEligible=false rendered in the gate detail
        DecisionTrace t = KcpPlanner.trace(m, TASK, agentOptions());
        UnitTrace soft = t.units().stream().filter(u -> u.id().equals("rollback-skill")).findFirst().orElse(null);
        assertNotNull(soft);
        GateVerdict softGate = soft.gates().stream().filter(g -> g.gate() == GateName.SKILL_ELIGIBILITY).findFirst().orElse(null);
        assertNotNull(softGate);
        assertTrue(softGate.passed());
        assertTrue(softGate.detail().contains("no explicit eligibility grant"));

        // strict: fail-closed at its own gate
        DecisionTrace ts = KcpPlanner.trace(m, TASK, agentStrictOptions());
        UnitTrace hard = ts.units().stream().filter(u -> u.id().equals("rollback-skill")).findFirst().orElse(null);
        assertNotNull(hard);
        assertEquals("skipped", hard.outcome());
        assertEquals(GateName.SKILL_ELIGIBILITY, hard.rejectedBy());
        GateVerdict hardGate = hard.gates().stream().filter(g -> g.gate() == GateName.SKILL_ELIGIBILITY).findFirst().orElse(null);
        assertNotNull(hardGate);
        assertFalse(hardGate.passed());
        assertEquals("kind: skill not invoke-eligible: no explicit eligibility grant", hardGate.detail());
    }
}
