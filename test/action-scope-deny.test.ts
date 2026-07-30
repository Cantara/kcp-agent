import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/client.js";
import { plan, deniesToken, scopeAllows } from "../src/planner.js";

// RFC-0029 / KCP 0.31: action_scope gains an optional negative-scope sibling
// `deny` with the same {tools, paths, capabilities} shape as the allowlist. A
// token that matches `deny` is refused even when the allowlist grants it —
// deny-overrides-allow, deny-first, fail-closed. §4.3a.
const MANIFEST = `
project: skills-kb
version: 1.0.0
units:
  - id: deploy-skill
    path: skills/deploy.md
    intent: "How to deploy a release to production"
    kind: skill
    load_eligible: true
    audience: [agent]
    triggers: [deploy, release, production]
    action_scope:
      tools: [Bash, Read]
      paths: ["scripts/**", "config/**"]
      capabilities: [shell, network]
      deny:
        tools: [Bash]
        paths: ["config/secrets/**"]
        capabilities: [network]
`;

describe("action_scope.deny (RFC-0029 / KCP 0.31)", () => {
  const m = parseManifest(MANIFEST, "test");
  const skill = m.units.find((u) => u.id === "deploy-skill");

  it("parses action_scope.deny onto the unit, mirroring the allowlist shape", () => {
    expect(skill?.action_scope?.deny?.tools).toEqual(["Bash"]);
    expect(skill?.action_scope?.deny?.paths).toEqual(["config/secrets/**"]);
    expect(skill?.action_scope?.deny?.capabilities).toEqual(["network"]);
  });

  it("carries deny through to the plan's selected unit (browser bundle sees it)", () => {
    const p = plan(m, "how do I deploy a release to production?", {
      capabilities: { role: "agent" },
    });
    const sel = p.selected.find((u) => u.id === "deploy-skill");
    expect(sel?.action_scope?.deny?.tools).toEqual(["Bash"]);
  });

  it("deniesToken: a listed token is denied, an unlisted one is not", () => {
    const scope = skill?.action_scope;
    expect(deniesToken(scope, "tools", "Bash")).toBe(true);
    expect(deniesToken(scope, "tools", "Read")).toBe(false);
    expect(deniesToken(scope, "capabilities", "network")).toBe(true);
    expect(deniesToken(undefined, "tools", "Bash")).toBe(false);
  });

  it("deny overrides allow: a denied-but-allowlisted token is refused (fail-closed)", () => {
    const scope = skill?.action_scope;
    // Bash is on the allowlist AND on deny — deny wins.
    expect(scopeAllows(scope, "tools", "Bash")).toBe(false);
    // network is an allowed capability AND denied — deny wins.
    expect(scopeAllows(scope, "capabilities", "network")).toBe(false);
    // Read is allowlisted and not denied — permitted.
    expect(scopeAllows(scope, "tools", "Read")).toBe(true);
    // shell is allowlisted and not denied — permitted.
    expect(scopeAllows(scope, "capabilities", "shell")).toBe(true);
    // A token on neither list is refused (fail-closed: not on the allowlist).
    expect(scopeAllows(scope, "tools", "Delete")).toBe(false);
  });
});
