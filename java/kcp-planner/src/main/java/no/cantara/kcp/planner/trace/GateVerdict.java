package no.cantara.kcp.planner.trace;

/**
 * A single gate's verdict for a single unit. Mirrors {@code GateVerdict} in
 * {@code src/trace.ts}.
 *
 * @param gate   the gate evaluated
 * @param passed whether the unit passed it
 * @param detail a human-readable detail matching the planner's reason contract
 */
public record GateVerdict(GateName gate, boolean passed, String detail) {
}
