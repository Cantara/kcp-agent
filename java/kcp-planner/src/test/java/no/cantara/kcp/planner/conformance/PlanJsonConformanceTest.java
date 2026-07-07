package no.cantara.kcp.planner.conformance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import no.cantara.kcp.planner.AgentPlan;
import no.cantara.kcp.planner.KcpPlanner;
import no.cantara.kcp.planner.ManifestParser;
import no.cantara.kcp.planner.PlanOptions;
import no.cantara.kcp.planner.json.PlanJson;
import no.cantara.kcp.planner.model.Manifest;

import org.junit.jupiter.api.Test;

/**
 * Plan-serialization conformance. The {@code fixtures/plan/*.json} carry the exact
 * {@code JSON.stringify(plan, null, 2)} the TypeScript reference produces for every
 * vector. The Java {@link PlanJson} serializer must reproduce it byte-for-byte —
 * field order, JS number formatting, and optional-field omission included. This is
 * what the {@code kcp_plan} MCP tool and saved plan artifacts carry.
 */
class PlanJsonConformanceTest {

    @Test
    void planJsonMatchesReferenceByteForByte() throws Exception {
        List<Path> files = fixtureFiles();
        assertTrue(files.size() >= 10, "expected >= 10 plan fixtures, found " + files.size());
        List<String> failures = new ArrayList<>();
        for (Path f : files) {
            Map<?, ?> fx = (Map<?, ?>) ConformanceVectors.parseJson(Files.readString(f));
            Manifest m = ManifestParser.parse(str(fx.get("manifest")), str(fx.get("name")));
            PlanOptions options = ConformanceVectors.optionsFromMap((Map<?, ?>) fx.get("options"));
            AgentPlan plan = KcpPlanner.plan(m, str(fx.get("task")), options);
            String actual = PlanJson.toJson(plan, options);
            String expected = str(fx.get("expect"));
            if (!actual.equals(expected)) {
                failures.add("\n=== " + str(fx.get("name")) + " ===\n" + firstDiff(expected, actual));
            }
        }
        assertEquals(List.of(), failures, failures.size() + " plan fixture(s) diverged");
    }

    private static String firstDiff(String expected, String actual) {
        String[] e = expected.split("\n", -1);
        String[] a = actual.split("\n", -1);
        for (int i = 0; i < Math.max(e.length, a.length); i++) {
            String el = i < e.length ? e[i] : "<none>";
            String al = i < a.length ? a[i] : "<none>";
            if (!el.equals(al)) {
                return "  line " + (i + 1) + ":\n    expected: " + el + "\n    actual:   " + al;
            }
        }
        return "  (identical?)";
    }

    private static List<Path> fixtureFiles() throws Exception {
        URL url = PlanJsonConformanceTest.class.getClassLoader().getResource("fixtures/plan");
        if (url == null) {
            throw new IllegalStateException("missing test resource: fixtures/plan");
        }
        Path dir = Paths.get(url.toURI());
        try (Stream<Path> s = Files.list(dir)) {
            return s.filter(p -> p.getFileName().toString().endsWith(".json")).sorted().collect(Collectors.toList());
        }
    }

    private static String str(Object v) {
        return v == null ? null : v.toString();
    }
}
