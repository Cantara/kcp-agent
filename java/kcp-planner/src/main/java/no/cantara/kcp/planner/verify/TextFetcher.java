package no.cantara.kcp.planner.verify;

/**
 * Resolves a location (a local path or an {@code http(s)} URL) to its text
 * content. Injected into {@link VerifyOptions} so the verifier stays free of any
 * network dependency: the default reads local files, and the manifest client
 * supplies a guarded fetcher when remote signatures/keys must be retrieved.
 */
@FunctionalInterface
public interface TextFetcher {
    /**
     * Fetch the text at {@code location}.
     *
     * @param location a local path or {@code http(s)} URL
     * @return the text content
     * @throws Exception if the location cannot be read (reported as unverifiable)
     */
    String fetch(String location) throws Exception;
}
