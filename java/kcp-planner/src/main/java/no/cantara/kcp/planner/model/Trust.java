package no.cantara.kcp.planner.model;

/**
 * The manifest-level trust block. Mirrors the TypeScript
 * {@code trust?: { agent_requirements?: TrustAgentRequirements }} shape.
 *
 * @param agentRequirements the attestation requirements placed on the agent, if any
 */
public record Trust(TrustAgentRequirements agentRequirements) {
}
