package no.cantara.kcp.planner.conformance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import no.cantara.kcp.planner.conformance.ConformanceVectors.ConformanceVector;
import no.cantara.kcp.planner.conformance.ConformanceVectors.VectorOutcome;

import org.junit.jupiter.api.Test;

/**
 * The conformance proof. Load every {@code vectors/*.json} from the shared corpus,
 * run it through the Java planner, and deep-equal the outcome against {@code expect}.
 * If every vector passes, this implementation is conformant with the TypeScript
 * reference — the spec is unambiguous, and the Java and Rust ports agree.
 */
class ConformanceTest {

    @Test
    void corpusIsNonTrivial() {
        int n = ConformanceVectors.load().size();
        assertTrue(n >= 10, "expected >= 10 vectors, found " + n);
    }

    @Test
    void allVectorsPass() {
        List<String> failures = new ArrayList<>();
        for (Map.Entry<String, ConformanceVector> e : ConformanceVectors.load()) {
            ConformanceVector v = e.getValue();
            VectorOutcome actual = ConformanceVectors.runVector(v);
            if (!actual.equals(v.expect())) {
                failures.add("\n=== " + v.name() + " (" + e.getKey() + ") ===\n"
                        + "  expected: " + v.expect() + "\n"
                        + "  actual:   " + actual);
            }
        }
        assertTrue(failures.isEmpty(),
                failures.size() + " vector(s) failed:" + String.join("", failures));
    }

    @Test
    void vectorNamesMatchFilenames() {
        for (Map.Entry<String, ConformanceVector> e : ConformanceVectors.load()) {
            assertEquals(e.getValue().name() + ".json", e.getKey());
        }
    }
}
