package no.cantara.kcp.planner.spring;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Configuration for the KCP planner, bound from {@code kcp.planner.*}.
 *
 * <pre>{@code
 * kcp:
 *   planner:
 *     manifest-path: classpath:knowledge.yaml     # local file or classpath resource
 *     manifest-url: https://example.com/knowledge.yaml  # remote (overrides path)
 *     default-role: agent
 *     default-env: prod
 *     max-units: 5
 *     strict: false
 *     verify: false                               # verify the manifest signature on load
 *     refresh-interval: PT5M                       # re-fetch a remote manifest periodically
 *     ssrf-guard:
 *       enabled: true
 *       allow-http: false
 * }</pre>
 */
@ConfigurationProperties("kcp.planner")
public class KcpPlannerProperties {

    /** Local file or {@code classpath:} resource holding the {@code knowledge.yaml}. */
    private String manifestPath;

    /** Remote {@code https://} manifest URL. When set, overrides {@link #manifestPath}. */
    private String manifestUrl;

    /** The default agent role for audience targeting. */
    private String defaultRole = "agent";

    /** The default runtime environment for federation context selection. */
    private String defaultEnv;

    /** The default cap on selected units. */
    private int maxUnits = 5;

    /** Whether planning is fail-closed by default. */
    private boolean strict = false;

    /** Whether to verify the manifest signature when loading. */
    private boolean verify = false;

    /** How often to re-fetch a remote manifest; {@code null} disables periodic refresh. */
    private Duration refreshInterval;

    /** The SSRF-guard policy for remote manifest fetches. */
    private final SsrfGuard ssrfGuard = new SsrfGuard();

    /** SSRF-guard settings for remote manifest fetches. */
    public static class SsrfGuard {
        /** Whether the guard is enabled (refuse private/loopback hosts). */
        private boolean enabled = true;
        /** Whether to permit cleartext {@code http://} and private hosts (implies guard relaxation). */
        private boolean allowHttp = false;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public boolean isAllowHttp() {
            return allowHttp;
        }

        public void setAllowHttp(boolean allowHttp) {
            this.allowHttp = allowHttp;
        }
    }

    public String getManifestPath() {
        return manifestPath;
    }

    public void setManifestPath(String manifestPath) {
        this.manifestPath = manifestPath;
    }

    public String getManifestUrl() {
        return manifestUrl;
    }

    public void setManifestUrl(String manifestUrl) {
        this.manifestUrl = manifestUrl;
    }

    public String getDefaultRole() {
        return defaultRole;
    }

    public void setDefaultRole(String defaultRole) {
        this.defaultRole = defaultRole;
    }

    public String getDefaultEnv() {
        return defaultEnv;
    }

    public void setDefaultEnv(String defaultEnv) {
        this.defaultEnv = defaultEnv;
    }

    public int getMaxUnits() {
        return maxUnits;
    }

    public void setMaxUnits(int maxUnits) {
        this.maxUnits = maxUnits;
    }

    public boolean isStrict() {
        return strict;
    }

    public void setStrict(boolean strict) {
        this.strict = strict;
    }

    public boolean isVerify() {
        return verify;
    }

    public void setVerify(boolean verify) {
        this.verify = verify;
    }

    public Duration getRefreshInterval() {
        return refreshInterval;
    }

    public void setRefreshInterval(Duration refreshInterval) {
        this.refreshInterval = refreshInterval;
    }

    public SsrfGuard getSsrfGuard() {
        return ssrfGuard;
    }
}
