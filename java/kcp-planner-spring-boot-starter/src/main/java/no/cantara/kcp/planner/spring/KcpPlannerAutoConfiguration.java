package no.cantara.kcp.planner.spring;

import no.cantara.kcp.planner.model.Manifest;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.core.io.ResourceLoader;

/**
 * Auto-configures the KCP planner from {@code kcp.planner.*}: loads the manifest and
 * exposes an injectable {@link ManifestSource}, {@link Manifest}, and
 * {@link KcpPlannerService}. Active in any Spring Boot application on the classpath; use
 * {@link EnableKcpPlanner} to opt in from a non-Boot Spring app.
 */
@AutoConfiguration
@EnableConfigurationProperties(KcpPlannerProperties.class)
public class KcpPlannerAutoConfiguration {

    /** The refreshable manifest holder; its {@code close()} shuts down any refresh scheduler. */
    @Bean(destroyMethod = "close")
    @ConditionalOnMissingBean
    public ManifestSource kcpManifestSource(KcpPlannerProperties props, ResourceLoader resourceLoader) {
        return new ManifestSource(props, resourceLoader);
    }

    /** The loaded manifest, injectable directly. */
    @Bean
    @ConditionalOnMissingBean
    public Manifest kcpManifest(ManifestSource source) {
        return source.manifest();
    }

    /** The injectable planning facade. */
    @Bean
    @ConditionalOnMissingBean
    public KcpPlannerService kcpPlannerService(ManifestSource source, KcpPlannerProperties props) {
        return new KcpPlannerService(source, props);
    }
}
