package no.cantara.kcp.planner.trace;

import java.util.List;

/**
 * The 13 gates of the planner cascade, in the exact evaluation order the planner
 * walks. Each constant carries its wire name — the lowercase, snake_case identifier
 * that appears in trace output and matches the TypeScript reference
 * ({@code audience}, {@code not_for}, …, {@code context_budget}).
 */
public enum GateName {
    AUDIENCE("audience"),
    NOT_FOR("not_for"),
    TEMPORAL("temporal"),
    DEPRECATED("deprecated"),
    SUPERSESSION("supersession"),
    RELEVANCE("relevance"),
    ATTESTATION("attestation"),
    PAYMENT("payment"),
    ACCESS("access"),
    STRICT("strict"),
    MAX_UNITS("max_units"),
    MONEY_BUDGET("money_budget"),
    CONTEXT_BUDGET("context_budget");

    private final String wire;

    GateName(String wire) {
        this.wire = wire;
    }

    /** The lowercase, snake_case wire name (e.g. {@code "money_budget"}). */
    public String wire() {
        return wire;
    }

    /** The full cascade in evaluation order. */
    public static final List<GateName> ORDER = List.of(values());

    /** Resolve a gate by its wire name. */
    public static GateName fromWire(String wire) {
        for (GateName g : values()) {
            if (g.wire.equals(wire)) {
                return g;
            }
        }
        throw new IllegalArgumentException("unknown gate: " + wire);
    }
}
