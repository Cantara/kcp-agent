package no.cantara.kcp.planner.client;

import java.time.Duration;

/**
 * The policy applied to every guarded network read. Mirrors {@code FetchGuard} in
 * {@code src/fetch.ts}: scheme, host, redirect, size, and time limits, fail-closed
 * by default.
 *
 * @param allowPrivate permit loopback / private / link-local hosts (and {@code http://}
 *                     to them); default {@code false}
 * @param maxBytes     max response bytes before the read is aborted; default 8 MiB
 * @param timeout      whole-exchange timeout; default 15 s
 */
public record FetchGuard(boolean allowPrivate, long maxBytes, Duration timeout) {

    /** 8 MiB — the default response-size ceiling. */
    public static final long DEFAULT_MAX_BYTES = 8L * 1024 * 1024;
    /** 15 seconds — the default whole-exchange timeout. */
    public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(15);

    /** The default guard: HTTPS-only to public hosts, 8 MiB, 15 s. */
    public static FetchGuard defaults() {
        return new FetchGuard(false, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT);
    }
}
