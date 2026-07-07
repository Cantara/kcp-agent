package no.cantara.kcp.planner;

/**
 * A unit the planner did not select, with the verbatim reason. The reason is part
 * of the spec's "every decision is a sentence" contract and is compared exactly by
 * the conformance vectors. Mirrors {@code SkippedUnit} in {@code src/planner.ts}.
 *
 * @param id     the unit id
 * @param reason the human-readable reason it was skipped
 */
public record SkippedUnit(String id, String reason) {
}
