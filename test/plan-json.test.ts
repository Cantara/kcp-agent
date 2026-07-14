import { describe, expect, it } from "vitest";
import { encodePlanJson, versionPlanJson } from "../src/plan-json.js";

describe("plan JSON contract", () => {
  it("adds the schema version and kind without hiding plan fields", () => {
    const artifact = versionPlanJson({ task: "deploy", selected: [] }, "plan");
    expect(artifact).toEqual({
      task: "deploy",
      selected: [],
      schemaVersion: 1,
      kind: "plan",
    });
  });

  it("distinguishes followed trees and traces", () => {
    expect(JSON.parse(encodePlanJson({ plans: [] }, "tree")).kind).toBe("tree");
    expect(JSON.parse(encodePlanJson({ plan: {} }, "trace")).kind).toBe("trace");
  });

  it("rejects non-object artifacts", () => {
    expect(() => versionPlanJson([], "plan")).toThrow("must be an object");
  });
});
