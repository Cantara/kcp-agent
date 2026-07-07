package no.cantara.kcp.planner.model;

/**
 * A rate-limit request count that is either a concrete number or the literal
 * {@code "unlimited"}. Mirrors the TypeScript {@code number | "unlimited"} union.
 */
public sealed interface RequestCount permits RequestCount.Limited, RequestCount.Unlimited {

    /** A finite ceiling of requests. */
    record Limited(long value) implements RequestCount {}

    /** The absence of a ceiling — the {@code "unlimited"} sentinel. */
    record Unlimited() implements RequestCount {}

    /** The shared {@code "unlimited"} instance. */
    Unlimited UNLIMITED = new Unlimited();
}
