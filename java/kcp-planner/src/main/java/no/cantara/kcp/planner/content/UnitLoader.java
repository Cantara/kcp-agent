package no.cantara.kcp.planner.content;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.PlannedUnit;
import no.cantara.kcp.planner.client.ManifestClient;

/**
 * Loads the content of a plan's load-eligible units — from disk for a local manifest,
 * or over HTTPS (through the SSRF guard) for a remote one. A port of
 * {@code loadPlannedUnits} in {@code src/synthesize.ts}. The LLM synthesis step itself
 * is out of scope for the Java library (an epic non-goal); this serves the bytes the
 * calling agent's own model answers from.
 */
public final class UnitLoader {

    private UnitLoader() {
    }

    private static final Pattern URL_SCHEME = Pattern.compile("^[a-z][a-z0-9+.-]*:", Pattern.CASE_INSENSITIVE);
    private static final Pattern HTTP = Pattern.compile("^https?://.*", Pattern.CASE_INSENSITIVE);

    /** A unit's loaded content with its citation-anchoring hash. Mirrors {@code LoadedUnit}. */
    public record LoadedUnit(String id, String path, String manifest, int chars, String sha256, String content) {
    }

    /** A unit that could not be served, with the reason. */
    public record UnavailableUnit(String id, String path, String reason) {
    }

    /** The result of loading a plan's units. */
    public record LoadResult(List<LoadedUnit> loaded, List<UnavailableUnit> unavailable) {
    }

    /**
     * Load the content of the plan's load-eligible units.
     *
     * @param plan   the plan whose selected units to load
     * @param client the client whose guard remote fetches pass through
     * @return the loaded units and the ones that were unavailable, with reasons
     */
    public static LoadResult loadPlannedUnits(AgentPlan plan, ManifestClient client) {
        List<LoadedUnit> loaded = new ArrayList<>();
        List<UnavailableUnit> unavailable = new ArrayList<>();
        String source = plan.manifest().source();
        boolean remote = source != null && HTTP.matcher(source).matches();
        Path baseDir = source != null && !remote ? Path.of(source).getParent() : null;

        for (PlannedUnit unit : plan.selected()) {
            if (!unit.loadEligible()) {
                unavailable.add(new UnavailableUnit(unit.id(), unit.path(), "not load-eligible in the plan"));
                continue;
            }
            if (unsafePath(unit.path())) {
                unavailable.add(new UnavailableUnit(unit.id(), unit.path(), "unsafe path (absolute, traversing, or a URL)"));
                continue;
            }
            if (remote) {
                try {
                    String url = URI.create(source).resolve(unit.path()).toString();
                    String content = client.guardedFetchText(url);
                    loaded.add(loadedUnit(unit, plan.manifest().project(), content));
                } catch (Exception e) {
                    unavailable.add(new UnavailableUnit(unit.id(), unit.path(),
                            "fetch failed: " + (e.getMessage() != null ? e.getMessage() : e.toString())));
                }
                continue;
            }
            if (baseDir == null) {
                unavailable.add(new UnavailableUnit(unit.id(), unit.path(), "manifest has no source; content not loadable"));
                continue;
            }
            Path abs = baseDir.resolve(unit.path());
            if (!Files.exists(abs)) {
                unavailable.add(new UnavailableUnit(unit.id(), unit.path(), "file not found on disk"));
                continue;
            }
            try {
                loaded.add(loadedUnit(unit, plan.manifest().project(), Files.readString(abs)));
            } catch (Exception e) {
                unavailable.add(new UnavailableUnit(unit.id(), unit.path(),
                        "read failed: " + (e.getMessage() != null ? e.getMessage() : e.toString())));
            }
        }
        return new LoadResult(loaded, unavailable);
    }

    private static LoadedUnit loadedUnit(PlannedUnit unit, String project, String content) {
        // `chars` is the UTF-16 length, matching the reference's String#length.
        return new LoadedUnit(unit.id(), unit.path(), project, content.length(),
                ManifestClient.sha256(content), content);
    }

    /** Reject paths that could escape the manifest's directory or origin. */
    private static boolean unsafePath(String path) {
        return Path.of(path).isAbsolute()
                || URL_SCHEME.matcher(path).find()
                || path.startsWith("//")
                || Arrays.asList(path.split("/")).contains("..");
    }
}
