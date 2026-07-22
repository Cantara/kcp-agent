package no.cantara.kcp.planner.assess;

import java.util.List;

/**
 * The confidence gate's verdict. Binary, with a written, specific reason — the
 * same shape contract as the pre-selection gates' {@code GateVerdict}
 * ({@code gate}/{@code passed}/{@code detail}), extended with the evidence the
 * decision was made from. Mirrors {@code ConfidenceVerdict} in
 * {@code src/assess.ts}.
 *
 * <p>Deliberately outside the gate cascade: it is never attached to a
 * {@code DecisionTrace} and does not touch {@code GateName} — {@code assess()}
 * runs downstream of synthesis, on content the planner's gates never see.</p>
 *
 * @param gate      always {@code "confidence"} — kept as a field (not a constant)
 *                  so the verdict renders with the other gates' zero new concepts
 * @param passed    whether the adjudicated score cleared {@code threshold}
 * @param threshold the pass/fail line, as supplied by the caller (0..1)
 * @param score     the adjudicated value (min or mean of {@code signals}, per
 *                  {@link AssessOptions#aggregate()}), rounded to 6 decimals
 * @param signals   the raw signal inputs, preserved for calibration and audit
 * @param detail    written, specific reason matching the gates' detail contract
 * @param severity  why this threshold applied (e.g. {@code "critical"}), when the
 *                  caller said so; {@code null} otherwise
 * @param asOf      the verdict's timestamp
 */
public record ConfidenceVerdict(
        String gate,
        boolean passed,
        double threshold,
        double score,
        List<ConfidenceSignal> signals,
        String detail,
        String severity,
        String asOf) {
}
