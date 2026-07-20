// Post-synthesis confidence gate — gating what may be *acted on*.
//
// The planner decides what may be loaded; grounding decides what may be
// asserted; assess() decides whether a conclusion clears the caller's
// confidence threshold before it is acted on. Same trust posture as
// grounding: confidence is a proposal (self-report or an injected
// evaluator); the gate adjudicates deterministically.
//
// Written test-first. The verdict reuses the GateVerdict contract
// (gate/passed/detail) but is a downstream artifact — it is never
// inserted into DecisionTrace, so conformance vectors are untouched.

import { describe, it, expect } from "vitest";
import {
  assess,
  extractSelfReport,
  makeProviderEvaluator,
  type ConfidenceEvaluator,
  type ConfidenceSignal,
} from "../src/assess.js";
import type { GroundUnit } from "../src/ground.js";
import type { SynthesisProvider } from "../src/provider.js";

const U = (id: string, content: string): GroundUnit => ({ id, sha256: `sha-${id}`, content });
const UNITS = [U("risk-policy", "Risk assessments require dual sign-off.")];

const signal = (source: "self" | "evaluator", score: number, reasoning = "because"): ConfidenceSignal =>
  ({ source, score, reasoning });

const evaluatorOf = (score: number, reasoning = "evaluator judgment"): ConfidenceEvaluator =>
  async () => signal("evaluator", score, reasoning);

describe("assess", () => {
  it("passes when the adjudicated score clears the threshold", async () => {
    const v = await assess("draft risk assessment", "Low risk.", UNITS, {
      threshold: 0.7,
      selfReport: signal("self", 0.9, "clear-cut case"),
    });
    expect(v.gate).toBe("confidence");
    expect(v.passed).toBe(true);
    expect(v.score).toBe(0.9);
    expect(v.threshold).toBe(0.7);
    expect(v.signals).toHaveLength(1);
    expect(v.detail).toContain("0.9");
    expect(v.detail).toContain("0.7");
  });

  it("fails with a written, specific reason when below threshold", async () => {
    const v = await assess("draft risk assessment", "Unsure.", UNITS, {
      threshold: 0.7,
      severity: "critical",
      selfReport: signal("self", 0.55, "conflicting inputs"),
    });
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0.55);
    expect(v.severity).toBe("critical");
    expect(v.detail).toContain("0.55");
    expect(v.detail).toContain("conflicting inputs");
  });

  it("aggregates multiple signals with min by default — fail-closed", async () => {
    const v = await assess("task", "Answer. Confidence: 0.9", UNITS, {
      threshold: 0.7,
      evaluator: evaluatorOf(0.6, "citations are thin"),
    });
    expect(v.signals).toHaveLength(2);
    expect(v.score).toBe(0.6);
    expect(v.passed).toBe(false);
    expect(v.detail).toContain("citations are thin");
  });

  it("aggregate: mean averages the signals", async () => {
    const v = await assess("task", "Answer. Confidence: 0.9", UNITS, {
      threshold: 0.7,
      evaluator: evaluatorOf(0.6),
      aggregate: "mean",
    });
    expect(v.score).toBeCloseTo(0.75);
    expect(v.passed).toBe(true);
  });

  it("no obtainable signal → fail-closed with a specific detail", async () => {
    const v = await assess("task", "An answer with no self-report.", UNITS, { threshold: 0.7 });
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
    expect(v.signals).toHaveLength(0);
    expect(v.detail).toMatch(/no confidence signal/i);
  });

  it("evaluator failure → fail-closed, the error becomes the detail", async () => {
    const broken: ConfidenceEvaluator = async () => { throw new Error("provider offline"); };
    const v = await assess("task", "Answer. Confidence: 0.95", UNITS, {
      threshold: 0.7,
      evaluator: broken,
    });
    expect(v.passed).toBe(false);
    expect(v.detail).toContain("provider offline");
  });

  it("evaluator returning an out-of-range score → fail-closed", async () => {
    const v = await assess("task", "Answer.", UNITS, {
      threshold: 0.7,
      evaluator: evaluatorOf(42, "not calibrated"),
    });
    expect(v.passed).toBe(false);
    expect(v.detail).toMatch(/out of range|invalid/i);
  });

  it("raw signals are preserved verbatim for calibration", async () => {
    const v = await assess("task", "Answer. Confidence: 80%", UNITS, {
      threshold: 0.5,
      evaluator: evaluatorOf(0.9, "well grounded"),
    });
    const sources = v.signals.map((s) => s.source).sort();
    expect(sources).toEqual(["evaluator", "self"]);
    for (const s of v.signals) {
      expect(s.reasoning).toBeTruthy();
    }
  });

  it("includeSelfReport: false ignores the answer's self-report", async () => {
    const v = await assess("task", "Answer. Confidence: 0.2", UNITS, {
      threshold: 0.7,
      evaluator: evaluatorOf(0.9),
      includeSelfReport: false,
    });
    expect(v.signals).toHaveLength(1);
    expect(v.score).toBe(0.9);
    expect(v.passed).toBe(true);
  });

  it("stamps asOf (caller-provided wins, for reproducibility)", async () => {
    const v = await assess("task", "Answer.", UNITS, {
      threshold: 0.7,
      selfReport: signal("self", 0.8),
      asOf: "2026-07-20",
    });
    expect(v.asOf).toBe("2026-07-20");
  });

  it("rejects an invalid threshold — caller error, not a verdict", async () => {
    await expect(assess("task", "Answer.", UNITS, { threshold: 7 })).rejects.toThrow(/threshold/);
    await expect(assess("task", "Answer.", UNITS, { threshold: -0.1 })).rejects.toThrow(/threshold/);
  });
});

describe("extractSelfReport", () => {
  it("parses a decimal confidence line", () => {
    const s = extractSelfReport("The risk is low.\n\nConfidence: 0.82");
    expect(s?.score).toBeCloseTo(0.82);
    expect(s?.source).toBe("self");
  });

  it("parses a percentage", () => {
    expect(extractSelfReport("Confidence: 82%")?.score).toBeCloseTo(0.82);
  });

  it("takes the last report when several appear", () => {
    const s = extractSelfReport("Confidence: 0.9 early on.\nFinal confidence: 0.6");
    expect(s?.score).toBeCloseTo(0.6);
  });

  it("returns undefined when no self-report exists", () => {
    expect(extractSelfReport("Just an answer.")).toBeUndefined();
  });

  it("clamps runaway percentages into range", () => {
    expect(extractSelfReport("Confidence: 150%")?.score).toBe(1);
  });
});

describe("makeProviderEvaluator", () => {
  const providerReturning = (text: string): SynthesisProvider => ({
    name: "fake",
    complete: async () => text,
    stream: async function* () { yield text; },
  }) as unknown as SynthesisProvider;

  it("parses the provider's JSON verdict into a signal", async () => {
    const ev = makeProviderEvaluator(providerReturning('{"score": 0.85, "reasoning": "claims match units"}'));
    const s = await ev({ task: "t", answer: "a", units: UNITS });
    expect(s.source).toBe("evaluator");
    expect(s.score).toBeCloseTo(0.85);
    expect(s.reasoning).toBe("claims match units");
  });

  it("strips markdown fences", async () => {
    const ev = makeProviderEvaluator(providerReturning('```json\n{"score": 0.5, "reasoning": "mixed"}\n```'));
    expect((await ev({ task: "t", answer: "a", units: UNITS })).score).toBe(0.5);
  });

  it("unparseable verdict → score 0, fail-closed", async () => {
    const ev = makeProviderEvaluator(providerReturning("I feel pretty good about it"));
    const s = await ev({ task: "t", answer: "a", units: UNITS });
    expect(s.score).toBe(0);
    expect(s.reasoning).toMatch(/unparseable/i);
  });
});
