import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleMessage, TOOLS, SERVER_INFO } from "../src/mcp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Rpc = { jsonrpc: string; id: number | string | null; result?: any; error?: any };

const call = (name: string, args: Record<string, unknown>, id = 1) =>
  handleMessage({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) as Promise<Rpc>;

describe("MCP server", () => {
  it("initializes with tools capability", async () => {
    const r = (await handleMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as Rpc;
    expect(r.result.serverInfo).toEqual(SERVER_INFO);
    expect(r.result.capabilities.tools).toBeDefined();
  });

  it("stays silent on notifications", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("lists the four tools", async () => {
    const r = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as Rpc;
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "kcp_plan", "kcp_load", "kcp_validate", "kcp_replay",
    ]);
    for (const t of TOOLS) expect(t.inputSchema).toBeDefined();
  });

  it("SERVER_INFO.version matches package.json (release drift fails here, not in the field)", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(SERVER_INFO.version).toBe(pkg.version);
  });

  it("kcp_plan returns a plan tree as JSON", async () => {
    const r = await call("kcp_plan", { task: "how do I deploy?", manifest: "examples/demo-hub", env: "prod" });
    expect(r.result.isError).toBe(false);
    const tree = JSON.parse(r.result.content[0].text);
    expect(tree.plan.manifest.project).toBe("acme-knowledge-hub");
    expect(tree.plan.selected.length).toBeGreaterThan(0);
  });

  it("kcp_plan surfaces the context budget over MCP", async () => {
    const r = await call("kcp_plan", {
      task: "sovereign compute award", manifest: "examples/fjordwire",
      methods: ["free", "x402"], as_of: "2026-07-06", context_budget: 3000,
    });
    const tree = JSON.parse(r.result.content[0].text);
    expect(tree.plan.context.ceiling).toBe(3000);
    expect(tree.plan.context.projectedTokens).toBe(2900);
    const skip = tree.plan.skipped.find((s: { id: string }) => s.id === "datacenter-power");
    expect(skip.reason).toMatch(/over context budget: 900 tokens/);
  });

  it("kcp_load returns unit contents for caller-side synthesis", async () => {
    const r = await call("kcp_load", { task: "how do I deploy?", manifest: "examples/demo-hub", env: "prod" });
    const payload = JSON.parse(r.result.content[0].text);
    const ids = payload.units.map((u: { id: string }) => u.id);
    expect(ids).toContain("deploy-guide");
    expect(payload.units.find((u: { id: string }) => u.id === "deploy-guide").content.length).toBeGreaterThan(0);
  });

  it("kcp_load dedups a unit the caller already holds, and re-serves it once it drifts", async () => {
    const first = await call("kcp_load", { task: "how do I deploy?", manifest: "examples/demo-hub", env: "prod" });
    const p1 = JSON.parse(first.result.content[0].text);
    const dg = p1.units.find((u: { id: string }) => u.id === "deploy-guide");
    // Second call: the caller declares it already holds deploy-guide at that sha.
    const second = await call("kcp_load", {
      task: "how do I deploy?", manifest: "examples/demo-hub", env: "prod",
      known: [{ id: "deploy-guide", sha256: dg.sha256 }],
    });
    const p2 = JSON.parse(second.result.content[0].text);
    const stub = p2.units.find((u: { id: string }) => u.id === "deploy-guide");
    expect(stub.unchanged).toBe(true);
    expect(stub.content).toBeUndefined();
    expect(p2.deduped).toContainEqual({ id: "deploy-guide", sha256: dg.sha256 });
    expect(p2.bytesSaved).toBeGreaterThan(0);
    // A stale sha (the caller's copy drifted) must re-serve the fresh bytes, never a stub.
    const stale = await call("kcp_load", {
      task: "how do I deploy?", manifest: "examples/demo-hub", env: "prod",
      known: [{ id: "deploy-guide", sha256: "stale-sha" }],
    });
    const reserved = JSON.parse(stale.result.content[0].text).units.find((u: { id: string }) => u.id === "deploy-guide");
    expect(reserved.unchanged).toBeUndefined();
    expect(reserved.content.length).toBeGreaterThan(0);
  });

  it("kcp_validate reports findings", async () => {
    const r = await call("kcp_validate", { manifest: "examples/demo-hub" });
    const report = JSON.parse(r.result.content[0].text);
    expect(report.ok).toBe(true);
  });

  it("tool errors are isError results, not protocol failures", async () => {
    const r = await call("kcp_plan", { task: "x", manifest: "does/not/exist" });
    expect(r.result.isError).toBe(true);
  });

  it("capability args reach the planner: attestation + credential gates answer over MCP", async () => {
    const base = {
      task: "quaymaster broker zero-day active exploitation - what do we do right now?",
      manifest: "examples/incident/nordlys",
    };
    const runbook = (tree: any) =>
      tree.plan.selected.find((u: { id: string }) => u.id === "incident-runbook");

    const cold = await call("kcp_plan", { ...base, as_of: "2026-07-08" });
    const coldRunbook = runbook(JSON.parse(cold.result.content[0].text));
    expect(coldRunbook.loadEligible).toBe(false);
    expect(coldRunbook.reasons).toContain("restricted: requires attestation the agent cannot present");

    const warm = await call("kcp_plan", {
      ...base,
      as_of: "2026-07-09",
      attest: "soc.nordlys.example",
      credentials: ["mtls"],
      methods: "free,x402", // CSV form — both list shapes are accepted
      budget: 0.5,
    });
    expect(runbook(JSON.parse(warm.result.content[0].text)).loadEligible).toBe(true);
  });

  it("kcp_replay verifies a kcp_plan artifact and catches a tampered one", async () => {
    const planned = await call("kcp_plan", {
      task: "quaymaster broker zero-day active exploitation - what do we do right now?",
      manifest: "examples/incident/nordlys",
      as_of: "2026-07-09",
      attest: "soc.nordlys.example",
      credentials: ["mtls"],
      methods: ["free", "x402"],
      budget: 0.5,
    });
    const artifact = planned.result.content[0].text;

    const ok = await call("kcp_replay", { artifact });
    const report = JSON.parse(ok.result.content[0].text);
    expect(report.ok).toBe(true);
    expect(report.checks.every((c: { status: string }) => c.status === "identical")).toBe(true);

    const tampered = JSON.parse(artifact);
    tampered.plan.budget.projectedSpend = 9.9; // the borrowing agent edits the ledger
    const caught = await call("kcp_replay", { artifact: tampered }); // object form is accepted too
    const drift = JSON.parse(caught.result.content[0].text);
    expect(drift.ok).toBe(false);
    expect(drift.checks[0].status).toBe("drifted");
    expect(drift.checks[0].fields).toContain("budget");
  });

  it("unknown methods get a JSON-RPC error", async () => {
    const r = (await handleMessage({ jsonrpc: "2.0", id: 9, method: "bogus/method" })) as Rpc;
    expect(r.error.code).toBe(-32601);
  });
});
