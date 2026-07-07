package no.cantara.kcp.planner.spring;

import no.cantara.kcp.planner.model.Manifest;

import org.springframework.boot.actuate.health.AbstractHealthIndicator;
import org.springframework.boot.actuate.health.Health;

/**
 * Reports the loaded manifest's status at {@code /actuator/health} as {@code kcpPlanner}:
 * project, version, unit count, KCP version, last refresh time, and (when verification is
 * enabled) the signature verdict. Only wired up when Spring Boot Actuator is on the
 * classpath.
 */
public class KcpPlannerHealthIndicator extends AbstractHealthIndicator {

    private final ManifestSource source;

    /**
     * @param source the loaded-manifest holder
     */
    public KcpPlannerHealthIndicator(ManifestSource source) {
        this.source = source;
    }

    @Override
    protected void doHealthCheck(Health.Builder builder) {
        ManifestSource.Snapshot s = source.snapshot();
        if (s == null || s.manifest() == null) {
            builder.down().withDetail("reason", "no manifest loaded");
            return;
        }
        Manifest m = s.manifest();
        builder.up()
                .withDetail("project", m.project())
                .withDetail("version", m.version())
                .withDetail("kcpVersion", m.kcpVersion() != null ? m.kcpVersion() : "(unset)")
                .withDetail("unitCount", m.units().size())
                .withDetail("source", s.source())
                .withDetail("lastRefresh", s.loadedAt().toString());
        if (s.signature() != null) {
            builder.withDetail("signatureStatus", s.signature().status())
                    .withDetail("signatureVerified", s.signature().verified());
        }
    }
}
