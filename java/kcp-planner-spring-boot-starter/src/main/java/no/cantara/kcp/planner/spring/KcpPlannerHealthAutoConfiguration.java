package no.cantara.kcp.planner.spring;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * Registers the {@link KcpPlannerHealthIndicator} — but only when Spring Boot Actuator is
 * on the classpath, so the starter works without it. The {@link ConditionalOnClass} guard
 * is evaluated from bytecode metadata, so the actuator-referencing indicator class is
 * never loaded when actuator is absent.
 */
@AutoConfiguration(after = KcpPlannerAutoConfiguration.class)
@ConditionalOnClass(name = "org.springframework.boot.actuate.health.HealthIndicator")
public class KcpPlannerHealthAutoConfiguration {

    /** The {@code kcpPlanner} health indicator. */
    @Bean
    @ConditionalOnBean(ManifestSource.class)
    @ConditionalOnMissingBean(name = "kcpPlannerHealthIndicator")
    public KcpPlannerHealthIndicator kcpPlannerHealthIndicator(ManifestSource source) {
        return new KcpPlannerHealthIndicator(source);
    }
}
