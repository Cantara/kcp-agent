package no.cantara.kcp.planner;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import no.cantara.kcp.planner.model.Manifest;

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
}
