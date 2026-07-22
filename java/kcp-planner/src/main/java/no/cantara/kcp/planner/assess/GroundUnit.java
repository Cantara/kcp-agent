package no.cantara.kcp.planner.assess;

/**
 * A loaded, hash-pinned unit of content — the minimal shape {@link Assess} needs
 * to hand a confidence evaluator the material an answer was allowed to draw on.
 * Mirrors the {@code id}/{@code sha256}/{@code content} shape of {@code GroundUnit}
 * in {@code src/ground.ts}. This is deliberately not a port of the full grounding
 * module ({@code src/ground.ts}) — {@code assess()} only needs this record.
 *
 * @param id      the unit id, as declared in the manifest
 * @param sha256  the content hash the answer's citation is pinned to
 * @param content the loaded unit content
 */
public record GroundUnit(String id, String sha256, String content) {
}
