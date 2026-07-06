// MCP ↔ CLI parity, with teeth. The planner's option surface is exposed twice —
// as CLI flags (parseArgs) and as MCP tool args (kcp_plan / kcp_load). Nothing
// stopped the two from drifting: add a planner option, wire the CLI, forget
// mcp.ts, and every other test still passed. This guard closes that gap the same
// way test/docs.test.ts guards the CLI reference — a single canonical registry
// that must be present, and consumed, on both surfaces.
//
// Adding a planner option now means adding a row here; that row is verified
// against the CLI switch, the MCP schema (both tools), and the actual mapping in
// toFollowOptions — so a half-wired option fails the build instead of shipping.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../src/mcp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

// The canonical planner-input surface: each option's CLI flag (kebab) and MCP
// argument name (snake). `task` and `manifest` are excluded — they are CLI
// positionals, not flags. `known` is excluded — it is a kcp_load-only dedup arg,
// not a planner input (covered by its own tests).
const PLANNER_OPTIONS = [
  { cli: "--env", mcp: "env" },
  { cli: "--as-of", mcp: "as_of" },
  { cli: "--max-units", mcp: "max_units" },
  { cli: "--strict", mcp: "strict" },
  { cli: "--budget", mcp: "budget" },
  { cli: "--currency", mcp: "currency" },
  { cli: "--context-budget", mcp: "context_budget" },
  { cli: "--follow", mcp: "follow" },
  { cli: "--max-depth", mcp: "max_depth" },
  { cli: "--max-nodes", mcp: "max_nodes" },
  { cli: "--allow-private-hosts", mcp: "allow_private_hosts" },
  { cli: "--role", mcp: "role" },
  { cli: "--methods", mcp: "methods" },
  { cli: "--credentials", mcp: "credentials" },
  { cli: "--attest", mcp: "attest" },
];

const cliSrc = read("src/cli.ts");
const mcpSrc = read("src/mcp.ts");
const cliFlags = new Set([...cliSrc.matchAll(/case "(--[a-z-]+)":/g)].map((m) => m[1]));

const tool = (name: string) => {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties);
};
const planArgs = new Set(tool("kcp_plan"));
const loadArgs = new Set(tool("kcp_load"));

describe("MCP ↔ CLI planner-surface parity", () => {
  it("every canonical option is a real CLI flag parseArgs accepts", () => {
    for (const o of PLANNER_OPTIONS) {
      expect(cliFlags, `CLI is missing ${o.cli}`).toContain(o.cli);
    }
  });

  it("every canonical option is exposed by BOTH kcp_plan and kcp_load", () => {
    for (const o of PLANNER_OPTIONS) {
      expect(planArgs, `kcp_plan is missing ${o.mcp}`).toContain(o.mcp);
      expect(loadArgs, `kcp_load is missing ${o.mcp}`).toContain(o.mcp);
    }
  });

  it("every canonical option is actually consumed by toFollowOptions (declared ≠ mapped)", () => {
    for (const o of PLANNER_OPTIONS) {
      expect(mcpSrc.includes(`args["${o.mcp}"]`), `mcp.ts never reads args["${o.mcp}"]`).toBe(true);
    }
  });

  it("kcp_plan exposes NO planner arg outside the canonical registry (forces new args to be registered)", () => {
    const known = new Set(["task", "manifest", ...PLANNER_OPTIONS.map((o) => o.mcp)]);
    for (const arg of planArgs) {
      expect(known, `kcp_plan arg '${arg}' is not in PLANNER_OPTIONS — add it (and its CLI flag) or exclude it`).toContain(arg);
    }
  });

  it("kcp_load is a superset of kcp_plan (dedup adds `known`, drops nothing)", () => {
    for (const arg of planArgs) expect(loadArgs).toContain(arg);
    expect(loadArgs).toContain("known");
  });
});
