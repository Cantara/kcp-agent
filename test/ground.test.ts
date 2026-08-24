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
import {
  splitClaims,
  groundAnswer,
  makeProviderVerifier,
  DEFAULT_VERIFIER_MAX_TOKENS,
  type GroundUnit,
  type Verifier,
} from "../src/ground.js";
import { formatGrounded } from "../src/format.js";
import type { SynthesisProvider, Message, CompletionOptions } from "../src/provider.js";

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

  // REVERSED 2026-08-22. This asserted `status: "grounded"` for an empty answer,
  // on the vacuous-truth reading: no claims, so "every claim is backed" holds.
  // That is sound logic and the wrong semantics for a safety property — the
  // caller cannot tell it apart from a real grounding, and one did exactly that
  // in production (see the "no claims is NOT grounded" block below for the field
  // report). Nothing is asserted, so nothing is grounded: "ungrounded".
  it("an empty answer is ungrounded — nothing asserted means nothing verified", async () => {
    const r = await groundAnswer("x", "", units, { verifier: substringVerifier });
    expect(r.status).toBe("ungrounded");
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

describe("groundAnswer — absence claims (the grounding-asymmetry fix)", () => {
  // Root cause this section guards against: a claim like "the document lacks
  // an information security policy" can never be textually SUPPORTED by any
  // unit — no document supports a statement about what it doesn't contain.
  // The old verifier contract (supportedBy: unitId | null) had no other path,
  // so every absence claim fell through to "unsupported" no matter how
  // correct it was. A verifier can now instead return `absenceConfirmed: true`
  // after reviewing the FULL loaded set — groundAnswer adjudicates that the
  // full set really was reviewed (same fail-closed spirit as citation
  // checking: the verifier's word alone is a proposal, not the grounding).
  const units = [U("policy-a", "Access control policy v2"), U("policy-b", "Incident response policy v1")];

  it("grounds an absence claim the verifier confirms after reviewing all loaded units", async () => {
    const absenceVerifier: Verifier = async () => ({ supportedBy: null, absenceConfirmed: true, note: "no unit addresses encryption-at-rest" });
    const r = await groundAnswer("is data encrypted at rest?", "The document does not address encryption at rest.", units, {
      verifier: absenceVerifier,
    });
    expect(r.status).toBe("grounded");
    expect(r.gaps).toEqual([]);
    expect(r.claims[0].grounded).toBe(true);
    expect(r.claims[0].groundedVia).toBe("absence");
    // no single citing unit — cited via the reviewed set, not one document
    expect(r.claims[0].unitId).toBeUndefined();
  });

  it("pins the reviewed set (id + sha256) for every loaded unit, not just a subset", async () => {
    const absenceVerifier: Verifier = async () => ({ supportedBy: null, absenceConfirmed: true });
    const r = await groundAnswer("x", "Nothing here covers that.", units, { verifier: absenceVerifier });
    expect(r.claims[0].reviewedUnits).toEqual([
      { id: "policy-a", sha256: "sha-policy-a" },
      { id: "policy-b", sha256: "sha-policy-b" },
    ]);
  });

  it("does NOT ground an absence claim the verifier can't confirm — absenceConfirmed defaults to a gap, same as before", async () => {
    const unsure: Verifier = async () => ({ supportedBy: null, note: "cannot rule out encryption is covered elsewhere" });
    const r = await groundAnswer("x", "The document does not address encryption.", units, { verifier: unsure });
    expect(r.status).toBe("partial-unsupported");
    expect(r.gaps).toHaveLength(1);
  });

  it("a positive supportedBy citation still wins over absenceConfirmed if a verifier (wrongly) sets both — citation is adjudicated, never trusted blindly, so this is deliberately not a crash but a defined precedence", async () => {
    const both: Verifier = async () => ({ supportedBy: "policy-a", absenceConfirmed: true });
    const r = await groundAnswer("x", "Access control policy v2 exists.", units, { verifier: both });
    expect(r.claims[0].groundedVia).toBe("citation");
    expect(r.claims[0].unitId).toBe("policy-a");
  });

  it("REGRESSION: existing citation-based grounding still works, now consistently labeled", async () => {
    const r = await groundAnswer("x", "Access control policy v2.", units, { verifier: substringVerifier });
    expect(r.claims[0].grounded).toBe(true);
    expect(r.claims[0].unitId).toBe("policy-a");
    // both paths now set groundedVia consistently, so callers can always ask "how" — this is new,
    // additive labeling on the existing citation path, not a behavior change to what gets grounded.
    expect(r.claims[0].groundedVia).toBe("citation");
  });
});

describe("groundAnswer — an answer with no claims is NOT grounded (fail-open fix)", () => {
  // Root cause this section guards against: `status` was derived purely from
  // "are there any gaps?", so an answer that yields ZERO claims produced zero
  // gaps and was reported "grounded" — vacuously. Nothing was verified, and the
  // verifier was never even called, yet the caller receives the same
  // status: "grounded" it would get from a fully cited answer.
  //
  // Found 2026-08-22 running Sara against a local model (Qwen3-8B). A small
  // model frequently answers with nothing but the self-report trailer Sara asks
  // for — the entire completion is `Conclusion: not_fulfilled.\nConfidence: 0.9.`
  // Sara strips that trailer before grounding (correctly — it is a statement
  // about the verdict, not about the document), which leaves the empty string,
  // which splits into no claims. Sara then signed a grounded, 0.95-confidence
  // finding in which not one claim had been checked: 7 of 8 evaluations.
  //
  // Grounding is a positive assertion that the answer rests on the loaded
  // units. An empty answer cannot rest on anything, so the honest status is
  // "ungrounded" — fail closed, consistent with how every other unprovable
  // case in this file behaves.
  const units = [U("policy-a", "Access control policy v2")];

  it("reports ungrounded, not grounded, for an answer that yields no claims", async () => {
    let called = 0;
    const verifier: Verifier = async () => { called += 1; return { supportedBy: "policy-a" }; };
    const r = await groundAnswer("x", "", units, { verifier });
    expect(r.status).toBe("ungrounded");
    expect(r.claims).toEqual([]);
    expect(r.grounded).toEqual([]);
    // the verifier is never consulted, which is exactly why the old status was
    // indistinguishable from a real grounding
    expect(called).toBe(0);
  });

  it("treats a whitespace-only answer the same as an empty one", async () => {
    const verifier: Verifier = async () => ({ supportedBy: "policy-a" });
    const r = await groundAnswer("x", "   \n\n  \t ", units, { verifier });
    expect(r.status).toBe("ungrounded");
  });

  it("REGRESSION: an answer that does yield claims is unaffected", async () => {
    const r = await groundAnswer("x", "Access control policy v2.", units, { verifier: substringVerifier });
    expect(r.status).toBe("grounded");
    expect(r.claims).toHaveLength(1);
  });

  it("REGRESSION: a claim-bearing answer that fails verification still reports partial-unsupported, not ungrounded", async () => {
    const never: Verifier = async () => ({ supportedBy: null });
    const r = await groundAnswer("x", "Something the units never say.", units, { verifier: never });
    expect(r.status).toBe("partial-unsupported");
  });
});

describe("makeProviderVerifier — token budget (the 256-token-cap fix)", () => {
  // Root cause this section guards against: a reasoning/thinking model spends
  // its entire completion budget on chain-of-thought and returns an empty
  // string once truncated at 256 tokens — both roles (verifier AND
  // evaluator, though evaluator is assess.ts's concern) then fail closed,
  // which reads as "small/local models can't emit JSON" when the real cause
  // is the cap. The fix: make the budget configurable with a much higher
  // default, not a silent hardcoded 256.
  function recordingProvider(): { provider: SynthesisProvider; calls: (Message[] | undefined)[]; opts: (CompletionOptions | undefined)[] } {
    const opts: (CompletionOptions | undefined)[] = [];
    const calls: (Message[] | undefined)[] = [];
    const provider: SynthesisProvider = {
      name: "test",
      model: "test-model",
      complete: async (messages, options) => {
        calls.push(messages);
        opts.push(options);
        return JSON.stringify({ supportedBy: null });
      },
      stream: async function* () {},
    };
    return { provider, calls, opts };
  }

  it("defaults to a budget well above the old 256-token cap", async () => {
    const { provider, opts } = recordingProvider();
    const verifier = makeProviderVerifier(provider);
    await verifier({ task: "x", claim: "x", units: [] });
    expect(opts[0]?.maxTokens).toBe(DEFAULT_VERIFIER_MAX_TOKENS);
    expect(DEFAULT_VERIFIER_MAX_TOKENS).toBeGreaterThan(256);
  });

  it("is configurable per call, for callers who know their model needs more or less", async () => {
    const { provider, opts } = recordingProvider();
    const verifier = makeProviderVerifier(provider, { maxTokens: 8192 });
    await verifier({ task: "x", claim: "x", units: [] });
    expect(opts[0]?.maxTokens).toBe(8192);
  });
});

describe("makeProviderVerifier — message ordering for prompt-cache reuse", () => {
  // Root cause this section guards against: groundAnswer() calls the
  // verifier once PER CLAIM in a synthesized answer (often 6-11 times for
  // one answer, per the local-LLM benchmark PR that surfaced this), always
  // against the SAME loaded units. Measured live (Bonsai-8B via
  // llama-server): prompt processing dominates wall-clock (~35-50s per
  // call at ~14.5 tok/s) far more than generation (2-11s) once reasoning
  // is off. llama-server's own prompt cache does longest-common-PREFIX
  // matching -- if the large, constant part (units) comes first and the
  // small, varying part (task/claim) comes last, every claim-check after
  // the first one only needs to prefill its own short tail, not the whole
  // units block again. The old ordering (task, then claim, then units)
  // put the varying part first, defeating prefix reuse entirely.
  function recordingProvider(): { provider: SynthesisProvider; lastMessages: () => Message[] | undefined } {
    let last: Message[] | undefined;
    const provider: SynthesisProvider = {
      name: "test",
      model: "test-model",
      complete: async (messages: Message[], _options?: CompletionOptions) => {
        last = messages;
        return JSON.stringify({ supportedBy: null });
      },
      stream: async function* () {},
    };
    return { provider, lastMessages: () => last };
  }

  it("puts the loaded units BEFORE the task and claim in the user message", async () => {
    const { provider, lastMessages } = recordingProvider();
    const verifier = makeProviderVerifier(provider);
    const units = [U("policy-a", "UNIQUE_UNIT_MARKER access control policy content")];
    await verifier({ task: "UNIQUE_TASK_MARKER check the policy", claim: "UNIQUE_CLAIM_MARKER the policy exists", units });
    const userMessage = lastMessages()?.find((m) => m.role === "user")?.content ?? "";
    const unitIdx = userMessage.indexOf("UNIQUE_UNIT_MARKER");
    const taskIdx = userMessage.indexOf("UNIQUE_TASK_MARKER");
    const claimIdx = userMessage.indexOf("UNIQUE_CLAIM_MARKER");
    expect(unitIdx).toBeGreaterThanOrEqual(0);
    expect(taskIdx).toBeGreaterThan(unitIdx);
    expect(claimIdx).toBeGreaterThan(taskIdx);
  });

  it("the units block is byte-identical across two calls with the same units but different claims — the actual prefix-cache precondition", async () => {
    const { provider, lastMessages } = recordingProvider();
    const verifier = makeProviderVerifier(provider);
    const units = [U("policy-a", "Access control policy v2"), U("policy-b", "Incident response policy v1")];
    await verifier({ task: "check compliance", claim: "the access policy exists", units });
    const firstMessage = lastMessages()?.find((m) => m.role === "user")?.content ?? "";
    await verifier({ task: "check compliance", claim: "a totally different claim about incident response", units });
    const secondMessage = lastMessages()?.find((m) => m.role === "user")?.content ?? "";
    // Both messages must share an identical PREFIX that actually contains
    // the units content -- not just shared label boilerplate ("Task: ...
    // Claim to verify:") that happens to precede the variable claim text
    // regardless of ordering. Find the longest common prefix directly and
    // assert it extends past where the (larger) units content lives.
    let i = 0;
    while (i < firstMessage.length && i < secondMessage.length && firstMessage[i] === secondMessage[i]) i++;
    const sharedPrefix = firstMessage.slice(0, i);
    expect(sharedPrefix).toContain("Access control policy v2");
    expect(sharedPrefix).toContain("Incident response policy v1");
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

  it("renders an absence-grounded claim without crashing on the missing single unitId, showing the reviewed-set count instead", async () => {
    const absenceVerifier: Verifier = async () => ({ supportedBy: null, absenceConfirmed: true });
    const g = await groundAnswer("x", "Nothing here covers encryption.", units, { verifier: absenceVerifier });
    const out = formatGrounded(g);
    expect(out).toMatch(/Grounded \(1/);
    expect(out).toContain("Nothing here covers encryption.");
    expect(out).toMatch(/2 units? reviewed/i);
    expect(out).not.toMatch(/undefined/);
  });
});
