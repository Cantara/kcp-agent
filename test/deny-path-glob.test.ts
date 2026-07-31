import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import {
  plan,
  pathGlobMatches,
  deniesToken,
  scopeAllows,
  effectiveDeniesToken,
} from "../src/planner.js";
import { validateManifest } from "../src/validate.js";

// §4.3a (v0.32.1 errata) — path entries in an action_scope are PATTERNS, matched
// structurally ("globs permitted", the `schema/secrets/**` carve-out). Exact-string
// comparison never fires them: no requested path is ever the literal string
// `legal/hold/**`, so the paths dimension of every deny (and allow) was unenforced.
// These tests pin the glob semantics (`**` crosses segments, `*` stays within one,
// everything else literal) for deniesToken, scopeAllows, the §4.3b union, the plan()
// orchestration gate, and the self-nullified-step lint — and pin that tools and
// capabilities stay exact tokens on both sides.

describe("pathGlobMatches (§4.3a, v0.32.1)", () => {
  it("** crosses segment boundaries", () => {
    expect(pathGlobMatches("legal/hold/**", "legal/hold/2025/case.pdf")).toBe(true);
    expect(pathGlobMatches("legal/hold/**", "legal/hold/x")).toBe(true);
    expect(pathGlobMatches("legal/hold/**", "legal/holdings/x")).toBe(false);
  });

  it("* stays within a single segment", () => {
    expect(pathGlobMatches("customers/*/pii", "customers/acme/pii")).toBe(true);
    expect(pathGlobMatches("customers/*/pii", "customers/a/b/pii")).toBe(false);
  });

  it("literal characters are escaped, not regex", () => {
    expect(pathGlobMatches("a.b/c", "a.b/c")).toBe(true);
    expect(pathGlobMatches("a.b/c", "axb/c")).toBe(false);
  });
});

describe("deny.paths matches structurally (§4.3a, v0.32.1)", () => {
  const scope = {
    paths: ["schema/**"],
    deny: { paths: ["schema/secrets/**", "legal/hold/**"], tools: ["delete"] },
  };

  it("a deny glob denies every path beneath it", () => {
    expect(deniesToken(scope, "paths", "legal/hold/2025/case.pdf")).toBe(true);
    expect(deniesToken(scope, "paths", "schema/secrets/key.pem")).toBe(true);
  });

  it("the carve-out fires: allowed region, prohibited hole", () => {
    expect(deniesToken(scope, "paths", "schema/api.json")).toBe(false);
    expect(deniesToken(scope, "paths", "schema/secrets/nested/key.pem")).toBe(true);
  });

  it("tools and capabilities remain exact tokens", () => {
    expect(deniesToken(scope, "tools", "delete")).toBe(true);
    expect(deniesToken(scope, "tools", "delete_all")).toBe(false);
  });

  it("the union (§4.3b) inherits glob matching from either source", () => {
    const pbScope = { deny: { paths: ["legal/hold/**"] } };
    const skillScope = { paths: ["customers/**"], deny: {} };
    expect(effectiveDeniesToken([pbScope, skillScope], "paths", "legal/hold/2025/x")).toBe(true);
    expect(effectiveDeniesToken([pbScope, skillScope], "paths", "customers/acme/x")).toBe(false);
  });
});

describe("scopeAllows adjudicates paths as patterns (§4.3a, v0.32.1)", () => {
  it("an allowlist glob puts every path beneath it in scope", () => {
    const scope = { paths: ["schema/**"] };
    expect(scopeAllows(scope, "paths", "schema/api.json")).toBe(true);
    expect(scopeAllows(scope, "paths", "schema/v2/api.json")).toBe(true);
    expect(scopeAllows(scope, "paths", "docs/api.json")).toBe(false);
  });

  it("carve-out: allow schema/** with deny schema/secrets/** — deny-first wins the hole", () => {
    const scope = { paths: ["schema/**"], deny: { paths: ["schema/secrets/**"] } };
    expect(scopeAllows(scope, "paths", "schema/api.json")).toBe(true);
    expect(scopeAllows(scope, "paths", "schema/secrets/key.pem")).toBe(false);
  });

  it("a deny glob overrides even an exact allowlist entry (the pre-errata hole)", () => {
    // Pre-errata: the exact allow entry matched, the deny pattern never fired, and
    // scopeAllows PASSED the request. Pinned refused now.
    const scope = {
      paths: ["legal/hold/2025/case.pdf"],
      deny: { paths: ["legal/hold/**"] },
    };
    expect(scopeAllows(scope, "paths", "legal/hold/2025/case.pdf")).toBe(false);
  });

  it("tools stay exact on the allow side too", () => {
    const scope = { tools: ["Read*"] };
    expect(scopeAllows(scope, "tools", "Read*")).toBe(true);
    expect(scopeAllows(scope, "tools", "ReadFile")).toBe(false);
  });
});

// A playbook whose deny lists `legal/hold/**` — the requested path is a concrete file
// beneath it, which exact-match adjudication could never refuse.
const PB = `
kcp_version: "0.32"
project: hold-kb
version: 1.0.0
units:
  - id: records-agent
    path: skills/records.md
    intent: "How to review records slated for archival"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [records, archive, review]
    action_scope:
      tools: [Read]
      paths: ["records/**", "legal/**"]
  - id: archive-sweep
    path: playbooks/archive.md
    intent: "How is the archival sweep executed?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [records, archive, review, sweep]
    action_scope:
      deny:
        paths: ["legal/hold/**"]
    steps:
      - id: review
        uses: records-agent
`;

describe("plan() gates a concrete path under a deny glob (§4.3b, RFC-0030)", () => {
  const m = parseManifest(PB, "test");
  const TASK = "how is the archival sweep executed?";
  const AGENT = { capabilities: { role: "agent" } };

  it("a playbook-scoped action on a denied path yields the prohibited-attempt marker", () => {
    const p = plan(m, TASK, {
      strict: true,
      action: { path: "legal/hold/2025/case.pdf" },
      ...AGENT,
    });
    const skip = p.skipped.find((s) => s.id === "archive-sweep");
    expect(skip).toBeDefined();
    expect(skip?.prohibitedAttempts?.[0]?.dimension).toBe("paths");
    expect(skip?.prohibitedAttempts?.[0]?.token).toBe("legal/hold/2025/case.pdf");
    expect(skip?.prohibitedAttempts?.[0]?.bindingSource).toBe("playbook action_scope.deny");
  });

  it("a path outside the deny glob keeps the playbook enactable", () => {
    const p = plan(m, TASK, {
      strict: true,
      action: { path: "records/2025/summary.md" },
      ...AGENT,
    });
    const pb = p.selected.find((u) => u.id === "archive-sweep");
    expect(pb).toBeDefined();
    expect(pb?.prohibitedAttempts).toBeUndefined();
  });
});

describe("self-nullified lint sees glob containment (§4.3b, RFC-0030)", () => {
  function manifest(skillPaths: string[], pbDenyPaths: string[]) {
    return parseManifest(
      `
kcp_version: "0.32"
project: lint-kb
version: 1.0.0
units:
  - id: hold-agent
    path: skills/hold.md
    intent: "How do I process records under legal hold?"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [legal, hold, records]
    action_scope:
      tools: [Read]
      paths: [${skillPaths.map((p) => JSON.stringify(p)).join(", ")}]
  - id: pb
    path: playbooks/hold.md
    intent: "How is legal-hold processing executed?"
    kind: playbook
    load_eligible: true
    audience: [agent]
    triggers: [legal, hold, records, process]
    action_scope:
      deny:
        paths: [${pbDenyPaths.map((p) => JSON.stringify(p)).join(", ")}]
    steps:
      - id: process
        uses: hold-agent
`,
      "test",
    );
  }

  it("warns when a broader deny glob covers every allowed path", () => {
    const findings = validateManifest(manifest(["legal/hold/2025/**"], ["legal/hold/**"]));
    expect(
      findings.some((f) => f.message.includes("self-nullified") && f.message.includes("'paths'")),
    ).toBe(true);
  });

  it("does not warn when the deny only carves a hole", () => {
    const findings = validateManifest(manifest(["customers/**"], ["customers/pii/**"]));
    expect(findings.some((f) => f.message.includes("self-nullified"))).toBe(false);
  });
});
