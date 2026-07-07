package no.cantara.kcp.planner.client;

import no.cantara.kcp.planner.model.Manifest;
import no.cantara.kcp.planner.verify.SignatureResult;

/**
 * A manifest as loaded by {@link ManifestClient}: the parsed model plus the exact
 * bytes it was parsed from, where it came from, the SHA-256 of those bytes (so a
 * saved plan pins the manifest it was computed from), and — when verification was
 * requested — the signature verdict.
 *
 * @param manifest  the parsed manifest
 * @param text      the exact manifest text
 * @param source    the path or URL it was loaded from
 * @param sha256    the hex SHA-256 of the manifest bytes
 * @param signature the signature verdict, or {@code null} when verification was not run
 */
public record LoadedManifest(Manifest manifest, String text, String source, String sha256, SignatureResult signature) {
}
