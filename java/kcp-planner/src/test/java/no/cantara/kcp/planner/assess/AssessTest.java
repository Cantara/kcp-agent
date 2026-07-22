package no.cantara.kcp.planner.assess;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * Translates the "assess" describe block of {@code test/assess.test.ts} 1:1.
 * The {@code makeProviderEvaluator}/{@code SynthesisProvider} describe block in
 * the TS reference has no Java equivalent — this port has no LLM provider
 * abstraction, by design (see {@link Assess} and {@link ConfidenceEvaluator}).
 */
class AssessTest {

    private static final List<GroundUnit> UNITS =
            List.of(new GroundUnit("risk-policy", "sha-risk-policy", "Risk assessments require dual sign-off."));

    private static ConfidenceSignal signal(String source, double score, String reasoning) {
        return new ConfidenceSignal(source, score, reasoning);
    }

    private static ConfidenceEvaluator evaluatorOf(double score, String reasoning) {
        return (task, answer, units) -> signal(ConfidenceSignal.EVALUATOR, score, reasoning);
    }

    @Test
    void passesWhenTheAdjudicatedScoreClearsTheThreshold() {
        ConfidenceVerdict v = Assess.assess("draft risk assessment", "Low risk.", UNITS,
                AssessOptions.builder(0.7)
                        .selfReport(signal(ConfidenceSignal.SELF, 0.9, "clear-cut case"))
                        .build());

        assertEquals("confidence", v.gate());
        assertTrue(v.passed());
        assertEquals(0.9, v.score());
        assertEquals(0.7, v.threshold());
        assertEquals(1, v.signals().size());
        assertTrue(v.detail().contains("0.9"));
        assertTrue(v.detail().contains("0.7"));
    }

    @Test
    void failsWithAWrittenSpecificReasonWhenBelowThreshold() {
        ConfidenceVerdict v = Assess.assess("draft risk assessment", "Unsure.", UNITS,
                AssessOptions.builder(0.7)
                        .severity("critical")
                        .selfReport(signal(ConfidenceSignal.SELF, 0.55, "conflicting inputs"))
                        .build());

        assertFalse(v.passed());
        assertEquals(0.55, v.score());
        assertEquals("critical", v.severity());
        assertTrue(v.detail().contains("0.55"));
        assertTrue(v.detail().contains("conflicting inputs"));
    }

    @Test
    void aggregatesMultipleSignalsWithMinByDefaultFailClosed() {
        ConfidenceVerdict v = Assess.assess("task", "Answer. Confidence: 0.9", UNITS,
                AssessOptions.builder(0.7)
                        .evaluator(evaluatorOf(0.6, "citations are thin"))
                        .build());

        assertEquals(2, v.signals().size());
        assertEquals(0.6, v.score());
        assertFalse(v.passed());
        assertTrue(v.detail().contains("citations are thin"));
    }

    @Test
    void aggregateMeanAveragesTheSignals() {
        ConfidenceVerdict v = Assess.assess("task", "Answer. Confidence: 0.9", UNITS,
                AssessOptions.builder(0.7)
                        .evaluator(evaluatorOf(0.6, "evaluator judgment"))
                        .aggregate("mean")
                        .build());

        assertEquals(0.75, v.score(), 1e-9);
        assertTrue(v.passed());
    }

    @Test
    void noObtainableSignalFailsClosedWithASpecificDetail() {
        ConfidenceVerdict v = Assess.assess("task", "An answer with no self-report.", UNITS,
                AssessOptions.builder(0.7).build());

        assertFalse(v.passed());
        assertEquals(0, v.score());
        assertEquals(0, v.signals().size());
        assertTrue(v.detail().toLowerCase().contains("no confidence signal"));
    }

    @Test
    void evaluatorFailureFailsClosedTheErrorBecomesTheDetail() {
        ConfidenceEvaluator broken = (task, answer, units) -> {
            throw new RuntimeException("provider offline");
        };
        ConfidenceVerdict v = Assess.assess("task", "Answer. Confidence: 0.95", UNITS,
                AssessOptions.builder(0.7).evaluator(broken).build());

        assertFalse(v.passed());
        assertTrue(v.detail().contains("provider offline"));
    }

    @Test
    void evaluatorReturningAnOutOfRangeScoreFailsClosed() {
        ConfidenceVerdict v = Assess.assess("task", "Answer.", UNITS,
                AssessOptions.builder(0.7).evaluator(evaluatorOf(42, "not calibrated")).build());

        assertFalse(v.passed());
        String detail = v.detail().toLowerCase();
        assertTrue(detail.contains("out of range") || detail.contains("invalid"));
    }

    @Test
    void rawSignalsArePreservedVerbatimForCalibration() {
        ConfidenceVerdict v = Assess.assess("task", "Answer. Confidence: 80%", UNITS,
                AssessOptions.builder(0.5).evaluator(evaluatorOf(0.9, "well grounded")).build());

        List<String> sources = v.signals().stream().map(ConfidenceSignal::source).sorted().toList();
        assertEquals(List.of(ConfidenceSignal.EVALUATOR, ConfidenceSignal.SELF), sources);
        for (ConfidenceSignal s : v.signals()) {
            assertTrue(s.reasoning() != null && !s.reasoning().isBlank());
        }
    }

    @Test
    void includeSelfReportFalseIgnoresTheAnswersSelfReport() {
        ConfidenceVerdict v = Assess.assess("task", "Answer. Confidence: 0.2", UNITS,
                AssessOptions.builder(0.7)
                        .evaluator(evaluatorOf(0.9, "evaluator judgment"))
                        .includeSelfReport(false)
                        .build());

        assertEquals(1, v.signals().size());
        assertEquals(0.9, v.score());
        assertTrue(v.passed());
    }

    @Test
    void stampsAsOfCallerProvidedWinsForReproducibility() {
        ConfidenceVerdict v = Assess.assess("task", "Answer.", UNITS,
                AssessOptions.builder(0.7)
                        .selfReport(signal(ConfidenceSignal.SELF, 0.8, "because"))
                        .asOf("2026-07-20")
                        .build());

        assertEquals("2026-07-20", v.asOf());
    }

    @Test
    void rejectsAnInvalidThresholdCallerErrorNotAVerdict() {
        IllegalArgumentException tooHigh = assertThrows(IllegalArgumentException.class,
                () -> Assess.assess("task", "Answer.", UNITS, AssessOptions.builder(7).build()));
        assertTrue(tooHigh.getMessage().contains("threshold"));

        IllegalArgumentException tooLow = assertThrows(IllegalArgumentException.class,
                () -> Assess.assess("task", "Answer.", UNITS, AssessOptions.builder(-0.1).build()));
        assertTrue(tooLow.getMessage().contains("threshold"));
    }

    // --- extractSelfReport (test/assess.test.ts, describe("extractSelfReport")) ---

    @Test
    void extractSelfReportParsesADecimalConfidenceLine() {
        ConfidenceSignal s = Assess.extractSelfReport("The risk is low.\n\nConfidence: 0.82");
        assertEquals(0.82, s.score(), 1e-9);
        assertEquals(ConfidenceSignal.SELF, s.source());
    }

    @Test
    void extractSelfReportParsesAPercentage() {
        assertEquals(0.82, Assess.extractSelfReport("Confidence: 82%").score(), 1e-9);
    }

    @Test
    void extractSelfReportTakesTheLastReportWhenSeveralAppear() {
        ConfidenceSignal s = Assess.extractSelfReport("Confidence: 0.9 early on.\nFinal confidence: 0.6");
        assertEquals(0.6, s.score(), 1e-9);
    }

    @Test
    void extractSelfReportReturnsNullWhenNoSelfReportExists() {
        assertNull(Assess.extractSelfReport("Just an answer."));
    }

    @Test
    void extractSelfReportClampsRunawayPercentagesIntoRange() {
        assertEquals(1.0, Assess.extractSelfReport("Confidence: 150%").score());
    }
}
