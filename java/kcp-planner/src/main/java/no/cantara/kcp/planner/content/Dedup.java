package no.cantara.kcp.planner.content;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import no.cantara.kcp.planner.content.UnitLoader.LoadedUnit;

/**
 * MCP session dedup — the caller-side of episodic memory. The caller declares the
 * units it already holds ({@code id → sha256}) and {@code kcp_load} withholds the
 * bytes it would otherwise re-serve, returning an "unchanged" stub instead. A stub is
 * only emitted on an EXACT sha match — an "unchanged" claim is a literal assertion the
 * bytes are identical, never a shortcut that hides a change. A port of
 * {@code src/session.ts}.
 */
public final class Dedup {

    private Dedup() {
    }

    /** A withheld unit the caller already holds at the same sha. Mirrors {@code UnchangedUnit}. */
    public record UnchangedUnit(String id, String path, String sha256, boolean unchanged, String note) {
    }

    /** A unit whose bytes were withheld. */
    public record DedupedRef(String id, String sha256) {
    }

    /**
     * The dedup outcome.
     *
     * @param units      the emitted units — each a {@link LoadedUnit} (full bytes) or an
     *                   {@link UnchangedUnit} (a withheld stub)
     * @param deduped    the units whose bytes were withheld
     * @param bytesSaved the total content characters withheld (the caller's window saving)
     */
    public record DedupResult(List<Object> units, List<DedupedRef> deduped, long bytesSaved) {
    }

    /** Normalize the caller's declared set (a list of {@code {id, sha256}} or an id→sha map) into a lookup. */
    public static Map<String, String> knownMap(Object known) {
        Map<String, String> m = new HashMap<>();
        if (known instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> k && k.get("id") instanceof String id) {
                    m.put(id, String.valueOf(k.get("sha256")));
                }
            }
        } else if (known instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> e : map.entrySet()) {
                m.put(String.valueOf(e.getKey()), String.valueOf(e.getValue()));
            }
        }
        return m;
    }

    /** Withhold the bytes of any loaded unit the caller already holds at the same sha; serve the rest. */
    public static DedupResult dedupeLoaded(List<LoadedUnit> loaded, Object known) {
        Map<String, String> have = knownMap(known);
        List<Object> units = new ArrayList<>();
        List<DedupedRef> deduped = new ArrayList<>();
        long bytesSaved = 0;
        for (LoadedUnit u : loaded) {
            if (u.sha256().equals(have.get(u.id()))) {
                String note = "unchanged since your copy (sha " + u.sha256().substring(0, 12) + "…) — not re-served";
                units.add(new UnchangedUnit(u.id(), u.path(), u.sha256(), true, note));
                deduped.add(new DedupedRef(u.id(), u.sha256()));
                bytesSaved += u.content().length();
            } else {
                units.add(u);
            }
        }
        return new DedupResult(units, deduped, bytesSaved);
    }
}
