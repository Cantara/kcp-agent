// Closed-loop grounding — a surfaced gap triggers another bounded navigation
// round to try to find the missing evidence. Written test-first; the pins here
// ARE the convergence proof:
//   1. a gap seeds terms → re-navigation → the new unit grounds the claim
//   2. progress guard: a round that adds no new unit halts (no oscillation)
//   3. round cap halts a persistently-ungroundable claim
//   4. absorbing gate: a term seeded once is never re-seeded
//   5. gate-dry (all gap terms already known) halts WITHOUT re-navigating
//   6. budget-blocked with no new units → partial-budget, distinctly
//   7. when it halts with a gap, the gap is still surfaced, never dropped
//
// navigate + verifier are injected, so the whole loop runs deterministically.

import { describe, it, expect } from "vitest";
import { groundingLoop, type GroundRoundFn } from "../src/groundloop.js";
import type { GroundUnit, Verifier } from "../src/ground.js";

const U = (id: string, content: string): GroundUnit => ({ id, sha256: `sha-${id}`, content });

/** Grounds a claim iff some loaded unit's content includes the claim (sans trailing punctuation). */
const substringVerifier: Verifier = async ({ claim, units }) => {
  const needle = claim.replace(/[.!?]+$/, "").trim();
  const hit = units.find((u) => u.content.includes(needle));
  return { supportedBy: hit ? hit.id : null };
};

describe("groundingLoop", () => {
  it("closes a gap: a surfaced gap seeds terms, re-navigation loads the evidence, the claim grounds", async () => {
    const base = [U("deploy-guide", "Deploy via the pipeline")];
    const answer = "Deploy via the pipeline. The datacenter runs on hydro power.";
    // round 0 lacks the power unit; round 1 (once terms mention "hydro/power") loads it.
    const navigate: GroundRoundFn = async (terms) => {
      if (terms.some((t) => /hydro|power|datacenter/.test(t))) {
        return { units: [...base, U("power-feed", "The datacenter runs on hydro power")], answer };
      }
      return { units: base, answer };
    };
    const r = await groundingLoop({ task: "deploy and power?", navigate, verifier: substringVerifier, maxRounds: 2 });
    expect(r.status).toBe("grounded");
    expect(r.final.gaps).toEqual([]);
    expect(r.rounds).toHaveLength(2); // base + one re-navigation
    expect(r.rounds[1].addedUnitIds).toContain("power-feed");
    expect(r.rounds[1].seededTerms.length).toBeGreaterThan(0);
    expect(r.answer).toContain("hydro power"); // the final synthesized answer text is carried through
  });

  it("progress guard: a round that adds no new unit halts instead of spinning", async () => {
    const units = [U("deploy-guide", "Deploy via the pipeline")];
    let calls = 0;
    const navigate: GroundRoundFn = async () => { calls++; return { units, answer: "Deploy via the pipeline. Unrelated claim." }; };
    const r = await groundingLoop({ task: "x", navigate, verifier: substringVerifier, maxRounds: 5 });
    expect(r.status).toBe("partial-unsupported");
    expect(r.final.gaps).toHaveLength(1); // the gap is still surfaced
    expect(calls).toBeLessThanOrEqual(2); // base + at most one re-navigation before the progress guard fires
  });

  it("round cap halts a persistently ungroundable claim even when each round loads something new", async () => {
    let n = 0;
    const navigate: GroundRoundFn = async () => {
      n++;
      return { units: [U(`u${n}`, "some other content")], answer: "A claim nothing supports." };
    };
    const r = await groundingLoop({ task: "x", navigate, verifier: substringVerifier, maxRounds: 1 });
    expect(r.status).toBe("partial-rounds");
    expect(r.rounds).toHaveLength(2); // base + exactly one extra round, then the cap
  });

  it("absorbing gate: a term seeded in one round is never seeded again", async () => {
    const seededAll: string[] = [];
    const navigate: GroundRoundFn = async () => ({
      units: [U("u", "x")],
      answer: "The subsea cable decided the compute award.", // stable gap text
    });
    // grounded never happens; capture seeded terms across rounds
    const r = await groundingLoop({ task: "x", navigate, verifier: substringVerifier, maxRounds: 3 });
    for (const round of r.rounds) seededAll.push(...round.seededTerms);
    expect(seededAll.length).toBe(new Set(seededAll).size); // no term seeded twice across the whole loop
  });

  it("gate-dry: when every gap term is already in the task, it halts WITHOUT re-navigating", async () => {
    let calls = 0;
    const navigate: GroundRoundFn = async () => {
      calls++;
      return { units: [U("u", "x")], answer: "deploy pipeline release." }; // all terms are in the task
    };
    const r = await groundingLoop({ task: "deploy pipeline release", navigate, verifier: substringVerifier, maxRounds: 3 });
    expect(r.status).toBe("partial-unsupported");
    expect(calls).toBe(1); // only the base navigation — the gate was dry, no re-navigation
  });

  it("budget-blocked with no new units is reported as partial-budget, distinctly", async () => {
    let calls = 0;
    const navigate: GroundRoundFn = async () => {
      calls++;
      return { units: [U("deploy-guide", "Deploy via the pipeline")], answer: "The premium feed says X.", budgetBlocked: true };
    };
    const r = await groundingLoop({ task: "premium feed data please", navigate, verifier: substringVerifier, maxRounds: 2 });
    expect(r.status).toBe("partial-budget");
    expect(r.final.gaps).toHaveLength(1); // still surfaced
  });

  it("a fully grounded base needs no rounds", async () => {
    const navigate: GroundRoundFn = async () => ({ units: [U("g", "Deploy via the pipeline")], answer: "Deploy via the pipeline." });
    const r = await groundingLoop({ task: "x", navigate, verifier: substringVerifier, maxRounds: 2 });
    expect(r.status).toBe("grounded");
    expect(r.rounds).toHaveLength(1);
  });
});
