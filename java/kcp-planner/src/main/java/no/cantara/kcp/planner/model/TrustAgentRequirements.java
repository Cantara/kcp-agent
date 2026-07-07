package no.cantara.kcp.planner.model;

import java.util.List;

/**
 * The attestation requirements a manifest places on the agent. When
 * {@code requireAttestation} is set, restricted units are gated unless the agent
 * can present an attestation from one of {@code trustedProviders}. Mirrors
 * {@code TrustAgentRequirements} in {@code src/model.ts}.
 *
 * @param requireAttestation whether restricted units require attestation
 * @param trustedProviders   attestation providers the manifest trusts
 * @param attestationUrl     where the agent can obtain an attestation
 */
public record TrustAgentRequirements(
        Boolean requireAttestation,
        List<String> trustedProviders,
        String attestationUrl) {
}
