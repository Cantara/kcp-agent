// Conformance harness for the confidence gate (#97).
//
// `assess()` adjudicates deterministically — threshold comparison, min/mean aggregation,
// self-report extraction, and every fail-closed rule — but had no vectors, so the Rust and
// Java ports could not claim conformance on it and it stayed "a TypeScript feature" rather
// than part of the protocol.
//
// The evaluator is injected and non-deterministic in production, so a vector supplies its
// *result* rather than invoking a judge: `evaluator` for a fixed signal, `evaluatorError`
// for one that throws. That is the same line the grounding tests draw — the vectors pin the
// adjudication of given signals, never the generation of them.
//
// These live in vectors/assess/ rather than vectors/. The planner harnesses in all three
// languages list vectors/*.json non-recursively, so a differently-shaped vector alongside
// them would be loaded as a planner vector and fail.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { assess, type ConfidenceSignal, type ConfidenceVerdict } from "../src/assess.js";

const DIR = path.resolve(__dirname, "..", "vectors", "assess");

interface AssessVector {
  name: string;
  gate: "confidence";
  spec: string;
  description: string;
  task: string;
  answer: string;
  units: [];
  options: Record<string, unknown>;
  evaluator?: { score: number; reasoning: string };
  evaluatorError?: string;
  expect?: {
    passed: boolean;
    score: number;
    threshold: number;
    severity?: string;
    signals: { source: string; score: number }[];
    detail: string;
  };
  expectError?: string;
}

const vectors: AssessVector[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as AssessVector);

describe("assess() conformance vectors", () => {
  // Without this, deleting the corpus would make the suite pass with nothing to check.
  it("loads the corpus", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
    for (const v of vectors) expect(v.gate, `${v.name} declares its gate`).toBe("confidence");
  });

  for (const v of vectors) {
    it(`${v.name}: ${v.description}`, async () => {
      const options: Record<string, unknown> = { ...v.options };

      if (v.evaluatorError !== undefined) {
        options.evaluator = async () => {
          throw new Error(v.evaluatorError);
        };
      } else if (v.evaluator) {
        const signal: ConfidenceSignal = { source: "evaluator", ...v.evaluator };
        options.evaluator = async () => signal;
      }

      if (v.expectError !== undefined) {
        await expect(assess(v.task, v.answer, v.units, options as never)).rejects.toThrow(v.expectError);
        return;
      }

      const verdict: ConfidenceVerdict = await assess(v.task, v.answer, v.units, options as never);
      const want = v.expect!;

      expect(verdict.gate).toBe("confidence");
      expect(verdict.passed, "passed").toBe(want.passed);
      expect(verdict.score, "score").toBe(want.score);
      expect(verdict.threshold, "threshold").toBe(want.threshold);
      // The detail is part of the contract, not decoration: it is what a human reads in an
      // audit, so a port that adjudicates identically but narrates differently is not
      // conformant.
      expect(verdict.detail, "detail").toBe(want.detail);
      expect(verdict.severity, "severity").toBe(want.severity);

      expect(verdict.signals.map((s) => ({ source: s.source, score: s.score }))).toEqual(want.signals);
    });
  }
});
