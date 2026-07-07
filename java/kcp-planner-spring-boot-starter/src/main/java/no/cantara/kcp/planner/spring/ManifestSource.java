package no.cantara.kcp.planner.spring;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import no.cantara.kcp.planner.ManifestParser;
import no.cantara.kcp.planner.client.LoadedManifest;
import no.cantara.kcp.planner.client.ManifestClient;
import no.cantara.kcp.planner.model.Manifest;
import no.cantara.kcp.planner.verify.ManifestVerifier;
import no.cantara.kcp.planner.verify.SignatureResult;

import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;

/**
 * Loads and holds the configured {@code knowledge.yaml}, refreshing a remote manifest
 * on the configured interval. A local file or {@code classpath:} resource is resolved
 * through Spring's {@link ResourceLoader}; a remote {@code https://} URL is fetched
 * through the SSRF-guarded {@link ManifestClient}.
 */
public class ManifestSource implements AutoCloseable {

    /** An immutable snapshot of a loaded manifest and its provenance. */
    public record Snapshot(Manifest manifest, String source, String sha256, SignatureResult signature, Instant loadedAt) {
    }

    private final KcpPlannerProperties props;
    private final ResourceLoader resourceLoader;
    private final AtomicReference<Snapshot> current = new AtomicReference<>();
    private volatile ScheduledExecutorService scheduler;

    /**
     * Load the manifest immediately and, for a remote URL with a refresh interval, start
     * periodic re-fetching.
     *
     * @param props          the planner configuration
     * @param resourceLoader Spring's resource loader (resolves {@code classpath:} and file paths)
     */
    public ManifestSource(KcpPlannerProperties props, ResourceLoader resourceLoader) {
        this.props = props;
        this.resourceLoader = resourceLoader;
        current.set(load());
        if (props.getManifestUrl() != null && props.getRefreshInterval() != null
                && !props.getRefreshInterval().isZero() && !props.getRefreshInterval().isNegative()) {
            long millis = props.getRefreshInterval().toMillis();
            scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "kcp-manifest-refresh");
                t.setDaemon(true);
                return t;
            });
            scheduler.scheduleWithFixedDelay(this::refreshQuietly, millis, millis, TimeUnit.MILLISECONDS);
        }
    }

    /** The current manifest. */
    public Manifest manifest() {
        return current.get().manifest();
    }

    /** The current snapshot (manifest + provenance). */
    public Snapshot snapshot() {
        return current.get();
    }

    /** Reload the manifest now, replacing the current snapshot. */
    public Snapshot refresh() {
        Snapshot s = load();
        current.set(s);
        return s;
    }

    private void refreshQuietly() {
        try {
            refresh();
        } catch (RuntimeException e) {
            // Keep the last good snapshot on a transient failure; the health indicator
            // surfaces staleness via loadedAt.
        }
    }

    private Snapshot load() {
        if (props.getManifestUrl() != null) {
            ManifestClient client = ManifestClient.builder().allowPrivate(allowPrivate()).build();
            try {
                LoadedManifest lm = client.load(props.getManifestUrl(), props.isVerify());
                return new Snapshot(lm.manifest(), lm.source(), lm.sha256(), lm.signature(), Instant.now());
            } catch (IOException e) {
                throw new IllegalStateException("failed to load manifest from " + props.getManifestUrl() + ": " + e.getMessage(), e);
            }
        }
        if (props.getManifestPath() != null) {
            String text = readResource(props.getManifestPath());
            Manifest manifest = ManifestParser.parse(text, props.getManifestPath());
            String sha = ManifestClient.sha256(text);
            SignatureResult sig = props.isVerify()
                    ? ManifestVerifier.verify(text, manifest.signing(), props.getManifestPath())
                    : null;
            return new Snapshot(manifest, props.getManifestPath(), sha, sig, Instant.now());
        }
        throw new IllegalStateException("no kcp.planner.manifest-path or kcp.planner.manifest-url configured");
    }

    private String readResource(String location) {
        Resource resource = resourceLoader.getResource(location);
        if (!resource.exists()) {
            throw new IllegalStateException("manifest resource not found: " + location);
        }
        try (InputStream in = resource.getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("failed to read manifest resource " + location + ": " + e.getMessage(), e);
        }
    }

    private boolean allowPrivate() {
        return !props.getSsrfGuard().isEnabled() || props.getSsrfGuard().isAllowHttp();
    }

    @Override
    public void close() {
        ScheduledExecutorService s = scheduler;
        if (s != null) {
            s.shutdownNow();
        }
    }
}
