// HTTP transport for the MCP server — `kcp-agent serve`.
//
// Exposes the same five MCP tools over HTTP, plus convenience REST endpoints
// for non-MCP consumers (dashboards, CI scripts, curl). Zero dependencies —
// uses node:http directly, same as stdio uses node:readline.
//
// Endpoints:
//   POST /mcp       — JSON-RPC 2.0 (delegates to handleMessage from mcp.ts)
//   POST /plan      — convenience REST: {task, manifest, ...options} → plan JSON
//   POST /trace     — convenience REST: {task, manifest, ...options} → trace JSON
//   POST /diff      — convenience REST: {a, b} → diff JSON
//   POST /validate  — convenience REST: {manifest} → validation report
//   GET  /health    — {status, version, tools, uptime}
//   OPTIONS *       — CORS preflight

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { handleMessage, TOOLS, SERVER_INFO } from "./mcp.js";

export interface ServeOptions {
  apiKey?: string;
}

const startTime = Date.now();

// ── CORS ────────────────────────────────────────────────────────────────

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ── Auth ────────────────────────────────────────────────────────────────

function checkAuth(req: IncomingMessage, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  const auth = req.headers["authorization"];
  if (!auth) return false;
  const [scheme, token] = auth.split(" ", 2);
  return scheme?.toLowerCase() === "bearer" && token === apiKey;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

// ── REST convenience wrappers ───────────────────────────────────────────
// These call the same MCP tool handlers via handleMessage, unwrapping the
// JSON-RPC envelope so REST consumers get plain JSON.

async function restPlan(body: Record<string, unknown>): Promise<unknown> {
  const rpc = await handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "kcp_plan", arguments: body },
  });
  return unwrapToolResult(rpc);
}

async function restTrace(body: Record<string, unknown>): Promise<unknown> {
  const rpc = await handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "kcp_trace", arguments: body },
  });
  return unwrapToolResult(rpc);
}

async function restDiff(body: Record<string, unknown>): Promise<unknown> {
  // The diff REST endpoint expects {a, b} where a and b are plan artifacts.
  // We compute the diff directly since it's a pure function.
  const { diffPlans } = await import("./diff.js");
  const a = body["a"] as Record<string, unknown> | undefined;
  const b = body["b"] as Record<string, unknown> | undefined;
  if (!a || !b) throw new Error("diff requires 'a' and 'b' plan artifacts");
  // Accept raw plans or tree/ask wrappers (extract .plan when present).
  const extractPlan = (obj: any) => obj.plan ?? obj;
  return diffPlans(extractPlan(a), extractPlan(b));
}

async function restValidate(body: Record<string, unknown>): Promise<unknown> {
  const rpc = await handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "kcp_validate", arguments: body },
  });
  return unwrapToolResult(rpc);
}

/** Unwrap a tools/call JSON-RPC result into the tool's output (parsed JSON or error). */
function unwrapToolResult(rpc: object | null): unknown {
  if (!rpc) throw new Error("no response");
  const r = rpc as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
  if (r.error) throw new Error(r.error.message ?? "JSON-RPC error");
  const content = r.result?.content?.[0]?.text;
  if (r.result?.isError) throw new Error(content ?? "tool error");
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

// ── Request handler ─────────────────────────────────────────────────────

function makeHandler(options: ServeOptions) {
  const apiKey = options.apiKey;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    setCorsHeaders(res);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Health check — unauthenticated
    if (pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, {
        status: "ok",
        version: SERVER_INFO.version,
        tools: TOOLS.length,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
      return;
    }

    // All other endpoints require auth (if configured)
    if (!checkAuth(req, apiKey)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    // JSON-RPC MCP endpoint
    if (pathname === "/mcp" && req.method === "POST") {
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 400, { error: "failed to read request body" });
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        });
        return;
      }
      const response = await handleMessage(msg as Parameters<typeof handleMessage>[0]);
      if (response) {
        sendJson(res, 200, response);
      } else {
        // Notification acknowledged silently — return 204
        res.writeHead(204);
        res.end();
      }
      return;
    }

    // REST convenience endpoints — all POST, all parse JSON body
    if (req.method === "POST" && ["/plan", "/trace", "/diff", "/validate"].includes(pathname)) {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }

      try {
        let result: unknown;
        switch (pathname) {
          case "/plan": result = await restPlan(body); break;
          case "/trace": result = await restTrace(body); break;
          case "/diff": result = await restDiff(body); break;
          case "/validate": result = await restValidate(body); break;
        }
        sendJson(res, 200, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    // Not found
    sendJson(res, 404, { error: "not found" });
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Start the HTTP server. Returns the node:http Server instance.
 * The server listens on the given port and delegates to the same
 * `handleMessage` used by the stdio MCP server.
 */
export function startServer(port: number, options: ServeOptions = {}): Server {
  const handler = makeHandler(options);
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error("kcp-agent serve: unhandled error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal server error" });
      }
    });
  });
  server.listen(port, () => {
    console.log(`kcp-agent HTTP server listening on port ${port}`);
    if (options.apiKey) console.log("  API key authentication enabled");
    console.log(`  ${TOOLS.length} tools available`);
  });
  return server;
}
