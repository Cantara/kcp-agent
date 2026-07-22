package no.cantara.kcp.planner;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import no.cantara.kcp.planner.diff.PlanDiff;
import no.cantara.kcp.planner.model.Manifest;
import no.cantara.kcp.planner.trace.DecisionTrace;
import no.cantara.kcp.planner.trace.GateName;
import no.cantara.kcp.planner.trace.UnitTrace;

import org.junit.jupiter.api.Test;

/**
 * Exercises the public {@link KcpPlanner} surface — the {@code plan(manifest, task)}
 * entry point, the {@link PlanOptions} builder, and the shape of {@link AgentPlan} —
 * independently of the conformance corpus.
 */
class KcpPlannerApiTest {

    private static final String MANIFEST = """
            kcp_version: "0.25"
            project: docs
            version: 1.0.0
            units:
              - id: deploy-guide
                path: ops/deploy.md
                intent: "How to deploy to production"
                audience: [agent]
                triggers: [deploy, production, release]
                size_tokens: 1200
              - id: hr-handbook
                path: hr/handbook.md
                intent: "Employee handbook"
                audience: [human]
                triggers: [handbook, benefits]
            """;

    @Test
    void planSelectsRelevantUnitAndSkipsOffAudience() {
        Manifest m = ManifestParser.parse(MANIFEST, "test");
        AgentPlan p = KcpPlanner.plan(m, "how do I deploy to production?");

        assertEquals(1, p.selected().size());
        assertEquals("deploy-guide", p.selected().get(0).id());
        assertTrue(p.selected().get(0).loadEligible());
        assertTrue(p.selected().get(0).score() > 0);

        // The human-only unit is skipped for the default "agent" role.
        assertTrue(p.skipped().stream().anyMatch(s -> s.id().equals("hr-handbook")));
        assertEquals("docs", p.manifest().project());
    }

    @Test
    void builderThreadsOptionsIntoThePlan() {
        Manifest m = ManifestParser.parse(MANIFEST, "test");
        AgentPlan p = KcpPlanner.plan(m, "deploy to production", PlanOptions.builder()
                .role("agent")
                .paymentMethods(List.of("free"))
                .maxUnits(10)
                .strict(true)
                .contextBudget(4000)
                .asOf("2026-07-06")
                .build());

        assertEquals("2026-07-06", p.asOf());
        assertEquals(4000L, p.context().ceiling());
        assertEquals(1200L, p.context().projectedTokens());
        assertEquals(2800L, p.context().remaining());
        assertFalse(p.context().approximate());
    }

    @Test
    void traceAnnotatesEveryUnitWithGateVerdicts() {
        Manifest m = ManifestParser.parse(MANIFEST, "test");
        DecisionTrace t = KcpPlanner.trace(m, "how do I deploy to production?");

        // One trace per manifest unit, in manifest order; the plan is the authority.
        assertEquals(2, t.units().size());
        assertEquals(2, t.plan().selected().size() + t.plan().skipped().size());

        UnitTrace deploy = t.units().get(0);
        assertEquals("deploy-guide", deploy.id());
        assertEquals("selected", deploy.outcome());
        // A selected unit walks the full cascade; the last gate is context_budget.
        assertEquals(GateName.CONTEXT_BUDGET, deploy.gates().get(deploy.gates().size() - 1).gate());

        UnitTrace hr = t.units().get(1);
        assertEquals("skipped", hr.outcome());
        assertEquals(GateName.AUDIENCE, hr.rejectedBy());
        assertEquals(1, hr.gates().size()); // stops after the first rejection

        // The gate summary spans all 14 gates.
        assertEquals(14, t.gateSummary().size());
    }

    @Test
    void diffDetectsAUnitFlippingSelectedToSkipped() {
        Manifest m = ManifestParser.parse(MANIFEST, "test");
        // As "agent", deploy-guide is selected; as "human" its audience excludes it,
        // so it flips to skipped — a genuine selected_to_skipped move.
        AgentPlan asAgent = KcpPlanner.plan(m, "deploy to production", PlanOptions.builder().role("agent").build());
        AgentPlan asHuman = KcpPlanner.plan(m, "deploy to production", PlanOptions.builder().role("human").build());

        PlanDiff diff = KcpPlanner.diffPlans(asAgent, asHuman);
        assertFalse(diff.identical());
        assertEquals(1, diff.moves().size());
        assertEquals("deploy-guide", diff.moves().get(0).id());
        assertEquals("selected_to_skipped", diff.moves().get(0).direction());
        assertEquals(16, diff.moves().get(0).from().score().intValue());

        assertTrue(KcpPlanner.diffPlans(asAgent, asAgent).identical());
    }
}
