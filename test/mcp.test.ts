import { describe, it, expect } from "vitest";
import { handleMessage, TOOLS, SERVER_INFO } from "../src/mcp.js";

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

  it("lists the three tools", async () => {
    const r = (await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as Rpc;
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual(["kcp_plan", "kcp_load", "kcp_validate"]);
    for (const t of TOOLS) expect(t.inputSchema).toBeDefined();
  });

  it("kcp_plan returns a plan tree as JSON", async () => {
    const r = await call("kcp_plan", { task: "how do I deploy?", manifest: "examples/demo-hub", env: "prod" });
    expect(r.result.isError).toBe(false);
    const tree = JSON.parse(r.result.content[0].text);
    expect(tree.plan.manifest.project).toBe("acme-knowledge-hub");
    expect(tree.plan.selected.length).toBeGreaterThan(0);
  });

  it("kcp_load returns unit contents for caller-side synthesis", async () => {
    const r = await call("kcp_load", { task: "how do I deploy?", manifest: "examples/demo-hub", env: "prod" });
    const payload = JSON.parse(r.result.content[0].text);
    const ids = payload.units.map((u: { id: string }) => u.id);
    expect(ids).toContain("deploy-guide");
    expect(payload.units.find((u: { id: string }) => u.id === "deploy-guide").content.length).toBeGreaterThan(0);
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

  it("unknown methods get a JSON-RPC error", async () => {
    const r = (await handleMessage({ jsonrpc: "2.0", id: 9, method: "bogus/method" })) as Rpc;
    expect(r.error.code).toBe(-32601);
  });
});
