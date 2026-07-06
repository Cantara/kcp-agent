// Answer grounding — the output-side analogue of the plan's fail-closed gates.
// A claim ships as an assertion only if a loaded, hash-pinned unit supports it;
// everything else is surfaced as an explicit gap, never silently dropped.
//
// Written test-first. The verifier is injected (an LLM in production), so the
// grounding contract is exercised deterministically here. The property that
// carries the security weight: a verifier that mis-attributes a claim to a unit
// that was not loaded can never ground it — membership + sha are checked in the
// deterministic layer, not trusted from the verifier.

import { describe, it, expect } from "vitest";
import { splitClaims, groundAnswer, type GroundUnit, type Verifier } from "../src/ground.js";
import { formatGrounded } from "../src/format.js";

const U = (id: string, content: string): GroundUnit => ({ id, sha256: `sha-${id}`, content });

/** A verifier that grounds a claim iff a unit's content includes the claim text. */
const substringVerifier: Verifier = async ({ claim, units }) => {
  const hit = units.find((u) => u.content.includes(claim.replace(/[.!?]+$/, "").trim()));
  return { supportedBy: hit ? hit.id : null };
};

describe("splitClaims", () => {
  it("splits an answer into sentence-level claims", () => {
    expect(splitClaims("Deploy via the pipeline. Roll back with the runbook.")).toEqual([
      "Deploy via the pipeline.",
      "Roll back with the runbook.",
    ]);
  });

  it("handles ! and ? and collapses whitespace/newlines", () => {
    expect(splitClaims("Is it safe?  Yes it is!\nAlways.")).toEqual(["Is it safe?", "Yes it is!", "Always."]);
  });

  it("returns nothing for an empty or whitespace answer", () => {
    expect(splitClaims("   \n  ")).toEqual([]);
  });
});

describe("groundAnswer — terminal grounding", () => {
  const units = [
    U("deploy-guide", "Deploy via the pipeline"),
    U("runbook", "Roll back with the runbook"),
  ];

  it("grounds every claim a loaded unit supports and pins its sha", async () => {
    const answer = "Deploy via the pipeline. Roll back with the runbook.";
    const r = await groundAnswer("how do I deploy and roll back?", answer, units, { verifier: substringVerifier });
    expect(r.status).toBe("grounded");
    expect(r.gaps).toEqual([]);
    expect(r.grounded.map((c) => [c.unitId, c.sha256])).toEqual([
      ["deploy-guide", "sha-deploy-guide"],
      ["runbook", "sha-runbook"],
    ]);
  });

  it("surfaces an unsupported claim as an explicit gap — never silently drops it", async () => {
    const answer = "Deploy via the pipeline. The datacenter runs on hydro power.";
    const r = await groundAnswer("deploy?", answer, units, { verifier: substringVerifier });
    expect(r.status).toBe("partial-unsupported");
    expect(r.grounded.map((c) => c.claim)).toEqual(["Deploy via the pipeline."]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].claim).toBe("The datacenter runs on hydro power.");
    expect(r.gaps[0].reason).toMatch(/no loaded unit supports/);
  });

  it("FAIL-CLOSED: a verifier that cites a unit which was not loaded cannot ground the claim", async () => {
    const liar: Verifier = async () => ({ supportedBy: "ghost-unit" }); // attributes to a non-loaded id
    const r = await groundAnswer("x", "A confident but unsupported sentence.", units, { verifier: liar });
    expect(r.status).toBe("partial-unsupported");
    expect(r.grounded).toEqual([]);
    expect(r.gaps[0].reason).toMatch(/cited unit 'ghost-unit' that was not loaded/);
  });

  it("carries the verifier's note into the gap reason when it supplies one", async () => {
    const noted: Verifier = async () => ({ supportedBy: null, note: "the units cover deploys, not pricing" });
    const r = await groundAnswer("price?", "It costs 5 USDC.", units, { verifier: noted });
    expect(r.gaps[0].reason).toMatch(/the units cover deploys, not pricing/);
  });

  it("caps surfaced gaps to guard against gap-flooding, and reports the truncation", async () => {
    const answer = "One. Two. Three. Four. Five."; // none supported
    const r = await groundAnswer("x", answer, units, { verifier: substringVerifier, maxGaps: 3 });
    expect(r.gaps).toHaveLength(3);
    expect(r.gapsTruncated).toBe(2);
    // the full record is retained even when the display list is capped
    expect(r.claims).toHaveLength(5);
    expect(r.claims.every((c) => !c.grounded)).toBe(true);
  });

  it("an empty answer grounds vacuously — nothing asserted, nothing to gap", async () => {
    const r = await groundAnswer("x", "", units, { verifier: substringVerifier });
    expect(r.status).toBe("grounded");
    expect(r.claims).toEqual([]);
    expect(r.gaps).toEqual([]);
  });

  it("the claims record is the full ordered audit table, grounded and gapped alike", async () => {
    const answer = "Deploy via the pipeline. Unsupported thing.";
    const r = await groundAnswer("x", answer, units, { verifier: substringVerifier });
    expect(r.claims.map((c) => c.grounded)).toEqual([true, false]);
    expect(r.claims[0].unitId).toBe("deploy-guide");
    expect(r.claims[1].unitId).toBeUndefined();
  });
});

describe("formatGrounded — the two-part artifact", () => {
  const units = [U("deploy-guide", "Deploy via the pipeline"), U("runbook", "Roll back with the runbook")];

  it("renders grounded claims with their unit citation and an Unsubstantiated block for gaps", async () => {
    const answer = "Deploy via the pipeline. The datacenter runs on hydro power.";
    const g = await groundAnswer("deploy?", answer, units, { verifier: substringVerifier });
    const out = formatGrounded(g);
    expect(out).toMatch(/Grounded \(1/);
    expect(out).toContain("deploy-guide");
    expect(out).toMatch(/Unsubstantiated \(1\)/);
    expect(out).toContain("The datacenter runs on hydro power.");
    expect(out).toMatch(/partial-unsupported/);
  });

  it("a fully grounded answer shows no Unsubstantiated block", async () => {
    const g = await groundAnswer("x", "Deploy via the pipeline.", units, { verifier: substringVerifier });
    const out = formatGrounded(g);
    expect(out).not.toMatch(/Unsubstantiated/);
    expect(out).toMatch(/grounded/);
  });

  it("notes when gaps were truncated by the cap", async () => {
    const g = await groundAnswer("x", "One. Two. Three.", units, { verifier: substringVerifier, maxGaps: 1 });
    const out = formatGrounded(g);
    expect(out).toMatch(/2 more/);
  });
});
