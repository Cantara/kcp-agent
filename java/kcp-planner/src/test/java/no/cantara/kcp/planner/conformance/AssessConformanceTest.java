package no.cantara.kcp.planner.conformance;

import no.cantara.kcp.planner.assess.Assess;
import no.cantara.kcp.planner.assess.AssessOptions;
import no.cantara.kcp.planner.assess.ConfidenceSignal;
import no.cantara.kcp.planner.assess.ConfidenceVerdict;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The confidence gate, pinned against the shared corpus in {@code vectors/assess/}.
 *
 * <p>Before these vectors existed the gate was adjudicated identically here and in
 * TypeScript by inspection only — nothing forced the two to agree, and a divergence in
 * aggregation or in a fail-closed rule would have gone unnoticed until it mattered.
 *
 * <p>The evaluator is injected and non-deterministic in production, so a vector supplies
 * its result rather than a judge: {@code evaluator} for a fixed signal, {@code
 * evaluatorError} for one that throws. The vectors pin adjudication, never generation.
 */
class AssessConformanceTest {

    private static Path assessVectorsDir() {
        return ConformanceVectors.vectorsDir().resolve("assess");
    }

    @TestFactory
    Stream<DynamicTest> everyAssessVector() throws IOException {
        List<Path> files;
        try (Stream<Path> s = Files.list(assessVectorsDir())) {
            files = s.filter(p -> p.getFileName().toString().endsWith(".json"))
                    .sorted(Comparator.comparing(Path::getFileName))
                    .toList();
        }

        // A corpus that silently emptied would turn this whole factory green with nothing
        // asserted, which is the failure mode a conformance suite can least afford.
        assertTrue(files.size() >= 15, "expected the assess corpus, found " + files.size() + " vector(s)");

        List<DynamicTest> tests = new ArrayList<>();
        for (Path file : files) {
            @SuppressWarnings("unchecked")
            Map<String, Object> v = (Map<String, Object>) ConformanceVectors.parseJson(Files.readString(file));
            tests.add(DynamicTest.dynamicTest((String) v.get("name"), () -> runVector(v)));
        }
        return tests.stream();
    }

    @SuppressWarnings("unchecked")
    private void runVector(Map<String, Object> v) {
        String task = (String) v.get("task");
        String answer = (String) v.get("answer");
        Map<String, Object> opts = (Map<String, Object>) v.get("options");

        AssessOptions.Builder b = AssessOptions.builder(num(opts.get("threshold")));
        if (opts.get("severity") != null) b.severity((String) opts.get("severity"));
        if (opts.get("aggregate") != null) b.aggregate((String) opts.get("aggregate"));
        if (opts.get("asOf") != null) b.asOf((String) opts.get("asOf"));
        if (opts.get("includeSelfReport") != null) b.includeSelfReport((Boolean) opts.get("includeSelfReport"));
        if (opts.get("selfReport") != null) {
            Map<String, Object> sr = (Map<String, Object>) opts.get("selfReport");
            b.selfReport(new ConfidenceSignal((String) sr.get("source"), num(sr.get("score")), (String) sr.get("reasoning")));
        }

        if (v.get("evaluatorError") != null) {
            String message = (String) v.get("evaluatorError");
            b.evaluator((t, ans, u) -> {
                throw new RuntimeException(message);
            });
        } else if (v.get("evaluator") != null) {
            Map<String, Object> e = (Map<String, Object>) v.get("evaluator");
            ConfidenceSignal signal = new ConfidenceSignal("evaluator", num(e.get("score")), (String) e.get("reasoning"));
            b.evaluator((t, ans, u) -> signal);
        }

        AssessOptions options = b.build();

        if (v.get("expectError") != null) {
            IllegalArgumentException thrown = assertThrows(
                    IllegalArgumentException.class,
                    () -> Assess.assess(task, answer, List.of(), options));
            assertEquals(v.get("expectError"), thrown.getMessage(), "error message");
            return;
        }

        Map<String, Object> want = (Map<String, Object>) v.get("expect");
        ConfidenceVerdict got = Assess.assess(task, answer, List.of(), options);

        assertEquals("confidence", got.gate(), "gate");
        assertEquals(want.get("passed"), got.passed(), "passed");
        assertEquals(num(want.get("score")), got.score(), 1e-9, "score");
        assertEquals(num(want.get("threshold")), got.threshold(), 1e-9, "threshold");
        assertEquals(want.get("severity"), got.severity(), "severity");
        // The detail is contract, not decoration: it is what a human reads in an audit, so
        // a port that adjudicates identically but narrates differently is not conformant.
        assertEquals(want.get("detail"), got.detail(), "detail");

        List<Map<String, Object>> wantSignals = (List<Map<String, Object>>) want.get("signals");
        assertEquals(wantSignals.size(), got.signals().size(), "signal count");
        for (int i = 0; i < wantSignals.size(); i++) {
            assertEquals(wantSignals.get(i).get("source"), got.signals().get(i).source(), "signal " + i + " source");
            assertEquals(num(wantSignals.get(i).get("score")), got.signals().get(i).score(), 1e-9, "signal " + i + " score");
        }
    }

    private static double num(Object o) {
        return ((Number) o).doubleValue();
    }
}
