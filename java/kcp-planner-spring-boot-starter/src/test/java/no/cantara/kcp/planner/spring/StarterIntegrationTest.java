package no.cantara.kcp.planner.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.model.Manifest;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * Boots a minimal Spring Boot context with the starter on the classpath and asserts the
 * planner auto-configures: the {@link Manifest} and {@link KcpPlannerService} beans are
 * injectable, planning works against the {@code classpath:knowledge.yaml}, and the
 * actuator health indicator reports the manifest status.
 */
@SpringBootTest(
        classes = StarterIntegrationTest.TestApp.class,
        properties = {
                "kcp.planner.manifest-path=classpath:knowledge.yaml",
                "kcp.planner.default-role=agent",
                "kcp.planner.max-units=3"
        })
class StarterIntegrationTest {

    @SpringBootConfiguration
    @EnableAutoConfiguration
    static class TestApp {
    }

    @Autowired
    KcpPlannerService planner;

    @Autowired
    Manifest manifest;

    @Autowired(required = false)
    KcpPlannerHealthIndicator health;

    @Test
    void beansAreAutoConfiguredAndInjectable() {
        assertNotNull(planner, "KcpPlannerService bean should be injectable");
        assertNotNull(manifest, "Manifest bean should be injectable");
        assertEquals("docs", manifest.project());
        assertEquals(2, manifest.units().size());
    }

    @Test
    void planningUsesTheConfiguredManifestAndDefaults() {
        AgentPlan plan = planner.plan("how do I deploy to production?");
        assertEquals(1, plan.selected().size());
        assertEquals("deploy-guide", plan.selected().get(0).id());
        // The human-only unit is skipped for the configured "agent" role.
        assertTrue(plan.skipped().stream().anyMatch(s -> s.id().equals("hr-handbook")));
    }

    @Test
    void healthIndicatorReportsManifestStatus() {
        assertNotNull(health, "the actuator health indicator should be wired up");
        Health h = health.health();
        assertEquals(Status.UP, h.getStatus());
        assertEquals("docs", h.getDetails().get("project"));
        assertEquals(2, h.getDetails().get("unitCount"));
        assertEquals("0.25", h.getDetails().get("kcpVersion"));
    }
}
