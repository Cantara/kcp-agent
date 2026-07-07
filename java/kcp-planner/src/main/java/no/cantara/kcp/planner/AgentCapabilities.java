package no.cantara.kcp.planner;

import java.util.List;

/**
 * What the agent can do — the identity and settlement capabilities the planner
 * matches units against. Mirrors {@code AgentCapabilities} in {@code src/planner.ts}.
 *
 * @param role                the role the agent presents (units target audiences)
 * @param paymentMethods      the payment method types the agent can settle
 * @param credentials         the credential kinds the agent holds
 * @param attestationProvider the attestation provider the agent can prove, or {@code null}
 */
public record AgentCapabilities(
        String role,
        List<String> paymentMethods,
        List<String> credentials,
        String attestationProvider) {

    /** The default capabilities: role {@code "agent"}, free payment only, no credentials. */
    public static final AgentCapabilities DEFAULT =
            new AgentCapabilities("agent", List.of("free"), List.of(), null);
}
