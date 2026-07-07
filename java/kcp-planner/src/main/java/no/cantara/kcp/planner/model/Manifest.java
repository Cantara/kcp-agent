package no.cantara.kcp.planner.model;

import java.util.List;

/**
 * A parsed {@code knowledge.yaml} — the compact subset of the KCP schema the
 * planner reasons about. Mirrors {@code Manifest} in {@code src/model.ts}. The
 * {@code units} and {@code manifests} lists are never {@code null} (the parser
 * normalizes a missing list to an empty one).
 *
 * @param project     the project name
 * @param version     the manifest version
 * @param kcpVersion  the KCP spec version the manifest targets
 * @param units       the knowledge units
 * @param manifests   federated sub-manifest references
 * @param payment     the manifest-level payment default
 * @param rateLimits  the manifest-level rate limits
 * @param trust       the manifest-level trust block
 * @param signing     the manifest-signing material
 * @param source      where the manifest was loaded from (path or URL); set by the client
 */
public record Manifest(
        String project,
        String version,
        String kcpVersion,
        List<Unit> units,
        List<ManifestRef> manifests,
        Payment payment,
        RateLimits rateLimits,
        Trust trust,
        Signing signing,
        String source) {
}
