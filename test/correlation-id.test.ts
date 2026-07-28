// #114 — pi-kcp's governed loop mints a W3C traceparent per turn and threads it through
// every evidence surface. kcp-memory recall takes it, the published context messages carry
// it, and the plan invocation rejected it outright, so a plan artifact could not be joined
// to the caller's decision chain.
//
// The id is opaque here on purpose. kcp-agent is not the authority on what a correlation
// id means — validating it as a traceparent would couple this CLI to one tracing format
// and break the moment a caller uses a different one.

import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { encodePlanJson, versionPlanJson } from "../src/plan-json.js";

describe("--correlation-id is parsed", () => {
  it("is accepted and captured", () => {
    expect(parseArgs(["plan", "x", "--correlation-id", "00-abc-def-01"]).correlationId).toBe("00-abc-def-01");
  });

  it("is absent when not supplied", () => {
    expect(parseArgs(["plan", "x"]).correlationId).toBeUndefined();
  });

  it("does not have to look like a traceparent", () => {
    // A caller using some other tracing scheme must not be rejected.
    expect(parseArgs(["plan", "x", "--correlation-id", "job-4711"]).correlationId).toBe("job-4711");
  });
});

describe("the --json envelope carries it", () => {
  it("sits alongside schemaVersion and kind", () => {
    const env = versionPlanJson({ task: "x" }, "plan", "00-abc-def-01");
    expect(env.correlationId).toBe("00-abc-def-01");
    expect(env.schemaVersion).toBe(1);
    expect(env.kind).toBe("plan");
  });

  // Purely additive: an artifact produced without the flag must be byte-identical to what
  // the previous version produced, or every stored plan artifact changes shape at once.
  it("is omitted entirely when no id was supplied", () => {
    const env = versionPlanJson({ task: "x" }, "plan");
    expect("correlationId" in env).toBe(false);
    expect(encodePlanJson({ task: "x" }, "plan")).toBe(
      JSON.stringify({ task: "x", schemaVersion: 1, kind: "plan" }, null, 2),
    );
  });

  it("an empty string is treated as absent, not as an empty id", () => {
    expect("correlationId" in versionPlanJson({ task: "x" }, "plan", "")).toBe(false);
  });

  it("survives encoding for every artifact kind", () => {
    for (const kind of ["plan", "tree", "trace"] as const) {
      const parsed = JSON.parse(encodePlanJson({ task: "x" }, kind, "cid-1"));
      expect(parsed.correlationId, `kind ${kind}`).toBe("cid-1");
    }
  });

  // The caller's id must not be overwritten by a colliding field on the artifact body,
  // nor silently win over one the caller explicitly passed.
  it("the explicit id wins over a field of the same name on the value", () => {
    const env = versionPlanJson({ correlationId: "from-body" }, "plan", "from-flag");
    expect(env.correlationId).toBe("from-flag");
  });
});
