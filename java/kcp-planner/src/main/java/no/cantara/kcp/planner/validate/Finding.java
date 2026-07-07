package no.cantara.kcp.planner.validate;

/**
 * A single lint result. Errors are structural problems that will mislead or fail an
 * agent; warnings are declarations that weaken navigation but don't break it.
 * Mirrors {@code Finding} in {@code src/validate.ts}.
 *
 * @param level   {@code "error"} or {@code "warning"}
 * @param where   the location, e.g. {@code "unit 'deploy-guide'"} or {@code "manifest"}
 * @param message the human-readable finding
 */
public record Finding(String level, String where, String message) {

    /** An error-level finding. */
    public static Finding error(String where, String message) {
        return new Finding("error", where, message);
    }

    /** A warning-level finding. */
    public static Finding warning(String where, String message) {
        return new Finding("warning", where, message);
    }
}
