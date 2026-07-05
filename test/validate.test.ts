import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { validateManifest, validateLocation } from "../src/validate.js";

const level = (findings: { level: string; message: string }[], lvl: string) =>
  findings.filter((f) => f.level === lvl).map((f) => f.message);

describe("validateManifest", () => {
  it("passes a clean manifest with no errors", () => {
    const m = parseManifest(`
kcp_version: "0.25"
project: ok
version: 1.0.0
units:
  - id: a
    path: docs/a.md
    intent: "Answers task A"
    audience: [agent]
    triggers: [alpha]
`);
    expect(level(validateManifest(m), "error")).toEqual([]);
  });

  it("flags duplicate and missing unit ids as errors", () => {
    const m = parseManifest(`
project: p
version: 1.0.0
units:
  - {id: a, path: x.md, intent: i, audience: [agent], triggers: [t]}
  - {id: a, path: y.md, intent: i, audience: [agent], triggers: [t]}
  - {path: z.md, intent: i, audience: [agent], triggers: [t]}
`);
    const errors = level(validateManifest(m), "error");
    expect(errors).toContain("duplicate unit id");
    expect(errors).toContain("missing 'id'");
  });

  it("flags unsafe unit paths", () => {
    const m = parseManifest(`
project: p
version: 1.0.0
units:
  - {id: abs, path: /etc/passwd, intent: i, audience: [agent], triggers: [t]}
  - {id: up, path: ../secrets.md, intent: i, audience: [agent], triggers: [t]}
  - {id: url, path: "https://evil.example/x.md", intent: i, audience: [agent], triggers: [t]}
`);
    expect(level(validateManifest(m), "error")).toHaveLength(3);
  });

  it("flags temporal problems", () => {
    const m = parseManifest(`
project: p
version: 1.0.0
units:
  - id: window
    path: a.md
    intent: i
    audience: [agent]
    triggers: [t]
    temporal: {valid_from: "2025-01-01", valid_until: "2024-01-01"}
  - id: dangling
    path: b.md
    intent: i
    audience: [agent]
    triggers: [t]
    temporal: {valid_until: "2020-01-01", superseded_by: nonexistent}
`);
    const errors = level(validateManifest(m), "error");
    expect(errors.some((e) => e.includes("ends"))).toBe(true);
    expect(errors.some((e) => e.includes("unknown unit 'nonexistent'"))).toBe(true);
  });

  it("warns on expired unit with no successor", () => {
    const m = parseManifest(`
project: p
version: 1.0.0
units:
  - id: old
    path: a.md
    intent: i
    audience: [agent]
    triggers: [t]
    temporal: {valid_until: "2020-01-01"}
`);
    expect(level(validateManifest(m), "warning").some((w) => w.includes("dead end"))).toBe(true);
  });

  it("flags permanently fail-closed attestation as an error", () => {
    const m = parseManifest(`
project: p
version: 1.0.0
trust:
  agent_requirements: {require_attestation: true}
units:
  - {id: a, path: x.md, intent: i, audience: [agent], triggers: [t]}
`);
    expect(level(validateManifest(m), "error").some((e) => e.includes("no agent can ever qualify"))).toBe(true);
  });

  it("warns when not_for contains the unit's own vocabulary (self-sabotaging gate)", () => {
    const m = parseManifest(`
project: p
version: 1.0.0
units:
  - id: eu-ai-act
    path: a.md
    intent: "EU AI Act requirements for high-risk AI systems"
    audience: [agent]
    triggers: [ai-act, high-risk]
    not_for: ["questions about non-AI software systems"]
`);
    const warnings = level(validateManifest(m), "warning");
    const hit = warnings.find((w) => w.includes("own vocabulary"));
    expect(hit).toBeDefined();
    expect(hit).toContain("systems");
  });

  it("does not warn when not_for names the excluded topic in its own words", () => {
    const m = parseManifest(`
project: p
version: 1.0.0
units:
  - id: eu-ai-act
    path: a.md
    intent: "EU AI Act requirements for high-risk AI systems"
    audience: [agent]
    triggers: [ai-act, high-risk]
    not_for: ["CCPA", "accounting"]
`);
    expect(level(validateManifest(m), "warning").some((w) => w.includes("own vocabulary"))).toBe(false);
  });

  it("checks unit paths exist when given a baseDir", async () => {
    const report = await validateLocation("examples/demo-hub");
    expect(report.ok).toBe(true); // demo hub must always validate clean
  });

  it("errors on a missing manifest", async () => {
    const report = await validateLocation("does/not/exist");
    expect(report.ok).toBe(false);
  });
});

describe("the repo's own manifest validates clean", () => {
  it("kcp-agent's knowledge.yaml has no errors", async () => {
    const report = await validateLocation(".");
    expect(report.findings.filter((f) => f.level === "error")).toEqual([]);
  });
});
