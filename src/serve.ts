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
//   GET/DELETE /mcp — 405 (no SSE stream, no sessions — stateless streamable HTTP)
//
// With --manifest, the server injects that manifest into any tool call or REST
// body that omits one, so remote MCP clients can call kcp_plan with just a task.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { handleMessage, TOOLS, SERVER_INFO } from "./mcp.js";
import { buildServingLinks, type ServingLinks } from "./serving.js";
import type { FetchGuard } from "./fetch.js";

export interface ServeOptions {
  apiKey?: string;
  /** Default manifest location injected into tool calls and REST bodies that omit one. */
  defaultManifest?: string;
  /** Public base URL this server is reachable at — self-checked against the manifest's serving.mcp (§3.12). */
  publicUrl?: string;
  /** Guard applied when loading the default manifest for Link headers / self-check. */
  fetchGuard?: FetchGuard;
}

/** The tools whose input schema takes a `manifest` argument. */
const MANIFEST_TOOLS = new Set(["kcp_plan", "kcp_load", "kcp_validate", "kcp_trace"]);

/**
 * Inject the server's default manifest into a tools/call message that omits one.
 * An explicit caller-provided manifest always wins.
 */
function withDefaultManifest(msg: unknown, defaultManifest: string | undefined): unknown {
  if (!defaultManifest || typeof msg !== "object" || msg === null) return msg;
  const m = msg as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  if (m.method !== "tools/call" || !m.params || !MANIFEST_TOOLS.has(m.params.name ?? "")) return msg;
  const args = m.params.arguments;
  if (args?.["manifest"] !== undefined) return msg;
  return { ...m, params: { ...m.params, arguments: { ...(args ?? {}), manifest: defaultManifest } } };
}

const startTime = Date.now();

// ── CORS ────────────────────────────────────────────────────────────────

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  // Link carries the RFC 8288 knowledge-manifest relations — browsers only
  // expose it to cross-origin JS when it is explicitly listed here.
  res.setHeader("Access-Control-Expose-Headers", "Link");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ── Serving discovery (RFC 8288 Link headers + §3.12 self-check) ────────
//
// A serving MCP endpoint should tell agents where the manifest that governs
// it lives: `Link: <url>; rel="knowledge-manifest"` (plus its signature and
// signing key when they are URL-addressable). And when that manifest declares
// `serving.mcp`, the server self-checks its own public URL against the list —
// a Level-2 SHOULD in KCP 0.26 that catches a misdeployed representative at
// startup instead of at the first refused plan.

/** Does this signing-block value look like something we can link to (URL or relative file), not inline material? */
function linkable(value: string | undefined): boolean {
  if (!value) return false;
  if (/^https?:\/\//.test(value)) return true;
  // Relative file convention (knowledge.yaml.sig, keys/kcp.pub, …) — short,
  // path-shaped, with an extension. Inline base64/PEM material is neither.
  return value.length <= 128 && /^[\w./-]+\.[A-Za-z0-9]+$/.test(value) && !value.includes("-----");
}

/** Load the default manifest (if any) and derive the Link header values + serving.mcp self-check. */
async function resolveServingLinks(options: ServeOptions): Promise<ServingLinks> {
  if (!options.defaultManifest) return { links: [] };
  try {
    const { loadManifest } = await import("./client.js");
    const { resolveLocation } = await import("./verify.js");
    const manifest = await loadManifest(options.defaultManifest, options.fetchGuard ?? {});
    // The manifest's public URL: where it was served from, or its first declared serving.manifest entry.
    const manifestUrl = /^https?:\/\//.test(manifest.source ?? "")
      ? manifest.source
      : manifest.serving?.manifest?.[0];
    const asUrl = (loc: string | undefined): string | undefined => {
      if (!linkable(loc)) return undefined;
      if (/^https?:\/\//.test(loc!)) return loc;
      if (!manifestUrl) return undefined; // relative with no public base — nothing to link
      return resolveLocation(manifestUrl, loc!);
    };
    return buildServingLinks({
      manifestUrl,
      signatureUrl: asUrl(manifest.signing?.signature),
      keyUrl: asUrl(manifest.signing?.public_key),
      servingMcp: manifest.serving?.mcp,
      publicUrl: options.publicUrl,
    });
  } catch (e) {
    return { links: [], warning: `could not load manifest for Link headers: ${e instanceof Error ? e.message : String(e)}` };
  }
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

function makeHandler(options: ServeOptions, servingLinks: Promise<ServingLinks>) {
  const apiKey = options.apiKey;
  const defaultManifest = options.defaultManifest;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    setCorsHeaders(res);

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // RFC 8288 discovery: /mcp and /health carry the knowledge-manifest links.
    if (pathname === "/mcp" || pathname === "/health") {
      const { links } = await servingLinks;
      if (links.length) res.setHeader("Link", links);
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

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
      msg = withDefaultManifest(msg, defaultManifest);
      const response = await handleMessage(msg as Parameters<typeof handleMessage>[0]);
      if (response) {
        sendJson(res, 200, response);
      } else {
        // Notification acknowledged — the MCP streamable-HTTP spec requires 202 Accepted.
        res.writeHead(202);
        res.end();
      }
      return;
    }

    // Streamable HTTP: we do not offer a server-initiated SSE stream or sessions,
    // so GET/DELETE on the MCP endpoint answer 405 per the spec.
    if (pathname === "/mcp" && (req.method === "GET" || req.method === "DELETE")) {
      res.writeHead(405, { Allow: "POST, OPTIONS" });
      res.end();
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

      // /plan, /trace and /validate take a manifest; fall back to the server default.
      if (defaultManifest && pathname !== "/diff" && body["manifest"] === undefined) {
        body["manifest"] = defaultManifest;
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
  // Resolved once, lazily awaited per request; the self-check warning is
  // logged as soon as the manifest loads — a misdeployed representative
  // (public URL not in serving.mcp) should be loud at startup.
  const servingLinks = resolveServingLinks(options);
  servingLinks.then(({ links, warning }) => {
    if (links.length) console.log(`  serving ${links.length} Link header(s) on /mcp and /health`);
    if (warning) console.warn(`  ⚠ serving: ${warning}`);
  });
  const handler = makeHandler(options, servingLinks);
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
