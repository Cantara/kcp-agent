package no.cantara.kcp.planner.validate;

import java.util.List;

/**
 * The result of linting a manifest. Mirrors {@code ValidationReport} in
 * {@code src/validate.ts}.
 *
 * @param source   where the manifest was loaded from
 * @param project  the manifest project, or {@code null} if it could not be parsed
 * @param findings the lint findings, in order
 * @param ok       true when there are no error-level findings (warnings allowed)
 */
public record ValidationReport(String source, String project, List<Finding> findings, boolean ok) {
}
