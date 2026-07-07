package no.cantara.kcp.planner.verify;

/**
 * Options for {@link ManifestVerifier}. Mirrors {@code VerifyOptions} in
 * {@code src/verify.ts}.
 *
 * @param trustedKey pinned key material (path, URL, or inline) that overrides any
 *                   key the manifest or signature envelope supplies, or {@code null}
 * @param fetchText  the fetcher for signature/key locations, or {@code null} to read
 *                   local files only (URLs then report as unverifiable)
 */
public record VerifyOptions(String trustedKey, TextFetcher fetchText) {

    /** Default options: no pinned key, local-file fetching only. */
    public static VerifyOptions defaults() {
        return new VerifyOptions(null, null);
    }

    /** Options with a fetcher for remote signature/key locations. */
    public static VerifyOptions withFetcher(TextFetcher fetchText) {
        return new VerifyOptions(null, fetchText);
    }
}
