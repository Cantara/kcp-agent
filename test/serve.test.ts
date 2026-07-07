import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { startServer } from "../src/serve.js";

// ── Helpers ─────────────────────────────────────────────────────────────

/** Make an HTTP request and return {status, headers, body}. */
function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Tests without auth ──────────────────────────────────────────────────

describe("HTTP serve (no auth)", () => {
  let server: http.Server;
  const PORT = 19876; // unlikely to collide

  beforeAll(async () => {
    server = startServer(PORT);
    // Wait for the server to be listening.
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.on("listening", resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("GET /health returns status, version, tools, uptime", async () => {
    const r = await request(PORT, "GET", "/health");
    expect(r.status).toBe(200);
    const h = JSON.parse(r.body);
    expect(h.status).toBe("ok");
    expect(h.version).toBeDefined();
    expect(h.tools).toBe(5);
    expect(typeof h.uptime).toBe("number");
  });

  it("health has CORS headers", async () => {
    const r = await request(PORT, "GET", "/health");
    expect(r.headers["access-control-allow-origin"]).toBe("*");
  });

  it("OPTIONS preflight returns 204 with CORS headers", async () => {
    const r = await request(PORT, "OPTIONS", "/mcp");
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("POST /mcp — JSON-RPC tools/list returns the five tools", async () => {
    const r = await request(PORT, "POST", "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(r.status).toBe(200);
    const rpc = JSON.parse(r.body);
    expect(rpc.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "kcp_plan", "kcp_load", "kcp_validate", "kcp_trace", "kcp_replay",
    ]);
  });

  it("POST /mcp — JSON-RPC initialize", async () => {
    const r = await request(PORT, "POST", "/mcp", {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(r.status).toBe(200);
    const rpc = JSON.parse(r.body);
    expect(rpc.result.serverInfo.name).toBe("kcp-agent");
  });

  it("POST /mcp — notification returns 204", async () => {
    const r = await request(PORT, "POST", "/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(r.status).toBe(204);
  });

  it("POST /plan — convenience REST returns a plan", async () => {
    const r = await request(PORT, "POST", "/plan", {
      task: "how do I deploy?",
      manifest: "examples/demo-hub",
      env: "prod",
    });
    expect(r.status).toBe(200);
    const plan = JSON.parse(r.body);
    expect(plan.plan.manifest.project).toBe("acme-knowledge-hub");
    expect(plan.plan.selected.length).toBeGreaterThan(0);
  });

  it("POST /trace — convenience REST returns a trace", async () => {
    const r = await request(PORT, "POST", "/trace", {
      task: "how do I deploy?",
      manifest: "examples/demo-hub",
    });
    expect(r.status).toBe(200);
    const trace = JSON.parse(r.body);
    expect(trace.task).toBe("how do I deploy?");
    expect(trace.units.length).toBeGreaterThan(0);
    expect(trace.gateSummary).toBeDefined();
  });

  it("POST /validate — convenience REST returns a validation report", async () => {
    const r = await request(PORT, "POST", "/validate", {
      manifest: "examples/demo-hub",
    });
    expect(r.status).toBe(200);
    const report = JSON.parse(r.body);
    expect(report.ok).toBe(true);
  });

  it("POST /plan — error returns 500 with error message", async () => {
    const r = await request(PORT, "POST", "/plan", {
      task: "x",
      manifest: "does/not/exist",
    });
    expect(r.status).toBe(500);
    const body = JSON.parse(r.body);
    expect(body.error).toBeDefined();
  });

  it("unknown path returns 404", async () => {
    const r = await request(PORT, "GET", "/nonexistent");
    expect(r.status).toBe(404);
  });

  it("POST /mcp — invalid JSON returns parse error", async () => {
    const r = await request(PORT, "POST", "/mcp", undefined, {});
    // Send raw invalid JSON
    const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: PORT, method: "POST", path: "/mcp", headers: { "Content-Type": "application/json" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write("{not valid json}");
      req.end();
    });
    expect(raw.status).toBe(200);
    const rpc = JSON.parse(raw.body);
    expect(rpc.error.code).toBe(-32700);
  });

  it("POST /diff — invalid body returns 500", async () => {
    const r = await request(PORT, "POST", "/diff", {});
    expect(r.status).toBe(500);
    const body = JSON.parse(r.body);
    expect(body.error).toMatch(/requires/);
  });
});

// ── Tests with API key auth ─────────────────────────────────────────────

describe("HTTP serve (with API key)", () => {
  let server: http.Server;
  const PORT = 19877;
  const API_KEY = "test-secret-key-42";

  beforeAll(async () => {
    server = startServer(PORT, { apiKey: API_KEY });
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.on("listening", resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("GET /health succeeds without auth (health is unauthenticated)", async () => {
    const r = await request(PORT, "GET", "/health");
    expect(r.status).toBe(200);
  });

  it("POST /mcp rejects without auth", async () => {
    const r = await request(PORT, "POST", "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(r.status).toBe(401);
  });

  it("POST /mcp rejects with wrong key", async () => {
    const r = await request(PORT, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: "Bearer wrong-key",
    });
    expect(r.status).toBe(401);
  });

  it("POST /mcp succeeds with correct Bearer token", async () => {
    const r = await request(PORT, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(r.status).toBe(200);
    const rpc = JSON.parse(r.body);
    expect(rpc.result.tools.length).toBe(5);
  });

  it("POST /plan rejects without auth", async () => {
    const r = await request(PORT, "POST", "/plan", {
      task: "how do I deploy?",
      manifest: "examples/demo-hub",
    });
    expect(r.status).toBe(401);
  });

  it("POST /plan succeeds with correct Bearer token", async () => {
    const r = await request(PORT, "POST", "/plan", {
      task: "how do I deploy?",
      manifest: "examples/demo-hub",
      env: "prod",
    }, {
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(r.status).toBe(200);
    const plan = JSON.parse(r.body);
    expect(plan.plan.manifest.project).toBe("acme-knowledge-hub");
  });
});
