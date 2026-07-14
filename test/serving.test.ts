// Serving Endpoint Binding (KCP §3.12, v0.26) — RFC-0024.
//
// A verified signature proves the bytes; the serving binding proves the
// *place*. These tests cover the §3.12 URL normalization rules, the §16.5 C22
// retrieval-URL check (threat T11: re-hosting a validly signed manifest), the
// §7 validation errors for non-https entries, the planner/format integration,
// and the RFC 8288 Link headers a serving MCP endpoint publishes.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { normalizeServingUrl, checkServing, buildServingLinks } from "../src/serving.js";
import { guardedFetchTextFinal } from "../src/fetch.js";
import { parseManifest } from "../src/client.js";
import { validateManifest } from "../src/validate.js";
import { plan } from "../src/planner.js";
import { formatPlan } from "../src/format.js";
import { startServer } from "../src/serve.js";

// ── §3.12 URL normalization ─────────────────────────────────────────────

describe("normalizeServingUrl (§3.12 matching rules)", () => {
  it("lowercases scheme and host", () => {
    expect(normalizeServingUrl("HTTPS://Docs.Example.COM/knowledge.yaml")).toBe(
      "https://docs.example.com/knowledge.yaml"
    );
  });

  it("strips the default port", () => {
    expect(normalizeServingUrl("https://example.com:443/k.yaml")).toBe("https://example.com/k.yaml");
    expect(normalizeServingUrl("http://example.com:80/k.yaml")).toBe("http://example.com/k.yaml");
  });

  it("keeps a non-default port", () => {
    expect(normalizeServingUrl("https://example.com:8443/k.yaml")).toBe("https://example.com:8443/k.yaml");
  });

  it("strips query and fragment", () => {
    expect(normalizeServingUrl("https://example.com/k.yaml?v=2#top")).toBe("https://example.com/k.yaml");
  });

  it("is exact on path — no wildcard, no trailing-slash folding", () => {
    expect(normalizeServingUrl("https://example.com/k.yaml/")).not.toBe(
      normalizeServingUrl("https://example.com/k.yaml")
    );
  });

  it("returns undefined for non-http(s) schemes and garbage", () => {
    expect(normalizeServingUrl("ftp://example.com/k.yaml")).toBeUndefined();
    expect(normalizeServingUrl("not a url")).toBeUndefined();
  });
});

// ── §16.5 C22 — the retrieval-URL check ─────────────────────────────────

describe("checkServing (C22)", () => {
  const serving = { manifest: ["https://docs.example.com/knowledge.yaml"], mcp: [] };

  it("returns undefined when the manifest declares no serving block", () => {
    expect(checkServing(undefined, "https://anywhere.example/k.yaml")).toBeUndefined();
  });

  it("reports no-binding when the serving block declares no manifest URLs", () => {
    const r = checkServing({ mcp: ["https://mcp.example.com/mcp"] }, "https://x.example/k.yaml");
    expect(r?.status).toBe("no-binding");
  });

  it("reports local for a filesystem source — binding applies to HTTP(S) retrieval only", () => {
    const r = checkServing(serving, "/home/user/project/knowledge.yaml");
    expect(r?.status).toBe("local");
  });

  it("binds when the retrieval URL is in the declared list (normalized)", () => {
    const r = checkServing(serving, "HTTPS://DOCS.EXAMPLE.COM:443/knowledge.yaml?cache=1");
    expect(r?.status).toBe("bound");
  });

  it("refuses to bind an undeclared retrieval URL and names both sides (T11)", () => {
    const r = checkServing(serving, "https://mirror.evil.example/knowledge.yaml");
    expect(r?.status).toBe("unbound");
    expect(r?.detail).toContain("https://mirror.evil.example/knowledge.yaml");
    expect(r?.detail).toContain("https://docs.example.com/knowledge.yaml");
    expect(r?.detail).toContain("known");
    expect(r?.retrievalUrl).toBe("https://mirror.evil.example/knowledge.yaml");
    expect(r?.declared).toEqual(serving.manifest);
  });

  it("path match is exact — a sibling path on the right host does not bind", () => {
    const r = checkServing(serving, "https://docs.example.com/other/knowledge.yaml");
    expect(r?.status).toBe("unbound");
  });
});

// ── Parsing ─────────────────────────────────────────────────────────────

describe("parseManifest — serving block", () => {
  it("parses serving.manifest and serving.mcp", () => {
    const m = parseManifest(`
project: p
version: 1.0.0
serving:
  manifest:
    - https://docs.example.com/knowledge.yaml
  mcp:
    - https://mcp.example.com/mcp
units: []
`);
    expect(m.serving?.manifest).toEqual(["https://docs.example.com/knowledge.yaml"]);
    expect(m.serving?.mcp).toEqual(["https://mcp.example.com/mcp"]);
  });

  it("leaves serving undefined when the manifest has none", () => {
    const m = parseManifest("project: p\nversion: 1.0.0\nunits: []\n");
    expect(m.serving).toBeUndefined();
  });
});

// ── §7 validation ───────────────────────────────────────────────────────

describe("validateManifest — serving entries", () => {
  it("errors on an http:// serving entry (§7)", () => {
    const m = parseManifest(`
project: p
version: 1.0.0
serving:
  manifest: ["http://docs.example.com/knowledge.yaml"]
  mcp: ["https://mcp.example.com/mcp"]
units:
  - {id: a, path: x.md, intent: i, audience: [agent], triggers: [t]}
`);
    const errors = validateManifest(m).filter((f) => f.level === "error");
    expect(errors.some((e) => e.message.includes("http://docs.example.com") && e.message.includes("https://"))).toBe(true);
  });

  it("accepts https entries and warns when the binding is unsigned", () => {
    const m = parseManifest(`
project: p
version: 1.0.0
serving:
  manifest: ["https://docs.example.com/knowledge.yaml"]
units:
  - {id: a, path: x.md, intent: i, audience: [agent], triggers: [t]}
`);
    const findings = validateManifest(m);
    expect(findings.filter((f) => f.level === "error")).toEqual([]);
    expect(findings.some((f) => f.level === "warning" && f.message.includes("without a signing block"))).toBe(true);
  });
});

// ── Planner + format integration ────────────────────────────────────────

const MANIFEST_YAML = `
project: bound-project
version: 1.0.0
kcp_version: "0.26"
serving:
  manifest: ["https://docs.example.com/knowledge.yaml"]
  mcp: ["https://mcp.example.com/mcp"]
units:
  - id: guide
    path: guide.md
    intent: "How to deploy the service"
    audience: [agent]
    triggers: [deploy]
`;

describe("plan — serving check surfaces next to the signature", () => {
  it("caps at known and warns when the source is an undeclared URL (C22)", () => {
    const m = parseManifest(MANIFEST_YAML, "https://mirror.evil.example/knowledge.yaml");
    const p = plan(m, "how do I deploy?");
    expect(p.serving?.status).toBe("unbound");
    const w = p.warnings.find((x) => x.startsWith("serving binding:"));
    expect(w).toBeDefined();
    expect(w).toContain("https://mirror.evil.example/knowledge.yaml");
    expect(w).toContain("https://docs.example.com/knowledge.yaml");
  });

  it("binds cleanly when the source is a declared URL", () => {
    const m = parseManifest(MANIFEST_YAML, "https://docs.example.com/knowledge.yaml");
    const p = plan(m, "how do I deploy?");
    expect(p.serving?.status).toBe("bound");
    expect(p.warnings.filter((x) => x.startsWith("serving binding:"))).toEqual([]);
  });

  it("reports local (not unbound) for a filesystem source", () => {
    const m = parseManifest(MANIFEST_YAML, "/home/user/knowledge.yaml");
    const p = plan(m, "how do I deploy?");
    expect(p.serving?.status).toBe("local");
    expect(p.warnings.filter((x) => x.startsWith("serving binding:"))).toEqual([]);
  });

  it("omits the serving field entirely when no serving block is declared", () => {
    const m = parseManifest("project: p\nversion: 1.0.0\nunits: []\n", "https://anywhere.example/k.yaml");
    expect(plan(m, "task").serving).toBeUndefined();
  });

  it("formatPlan renders a Serving line", () => {
    const m = parseManifest(MANIFEST_YAML, "https://mirror.evil.example/knowledge.yaml");
    const rendered = formatPlan(plan(m, "how do I deploy?"));
    expect(rendered).toContain("Serving:");
    expect(rendered).toContain("mirror.evil.example");
  });
});

// ── Link headers (RFC 8288) ─────────────────────────────────────────────

describe("buildServingLinks", () => {
  it("builds the three knowledge-manifest relations", () => {
    const { links } = buildServingLinks({
      manifestUrl: "https://docs.example.com/knowledge.yaml",
      signatureUrl: "https://docs.example.com/knowledge.yaml.sig",
      keyUrl: "https://docs.example.com/keys/kcp.pub",
    });
    expect(links).toEqual([
      '<https://docs.example.com/knowledge.yaml>; rel="knowledge-manifest"',
      '<https://docs.example.com/knowledge.yaml.sig>; rel="knowledge-manifest-signature"',
      '<https://docs.example.com/keys/kcp.pub>; rel="signing-key"',
    ]);
  });

  it("warns when the public URL is not in serving.mcp", () => {
    const { warning } = buildServingLinks({
      servingMcp: ["https://mcp.example.com/mcp"],
      publicUrl: "https://rogue.example.com/mcp",
    });
    expect(warning).toContain("rogue.example.com");
    expect(warning).toContain("mcp.example.com");
  });

  it("does not warn when the public URL matches after normalization", () => {
    const { warning } = buildServingLinks({
      servingMcp: ["https://mcp.example.com/mcp"],
      publicUrl: "HTTPS://MCP.EXAMPLE.COM:443/mcp",
    });
    expect(warning).toBeUndefined();
  });

  it("warns that it cannot self-check when serving.mcp is declared but no public URL given", () => {
    const { warning } = buildServingLinks({ servingMcp: ["https://mcp.example.com/mcp"] });
    expect(warning).toContain("--public-url");
  });

  it("emits no links and no warning with nothing to say", () => {
    expect(buildServingLinks({})).toEqual({ links: [], warning: undefined });
  });
});

// ── guardedFetchTextFinal — the post-redirect URL C22 compares ──────────

describe("guardedFetchTextFinal", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/moved") {
        res.writeHead(302, { location: "/final" });
        res.end();
        return;
      }
      if (req.url === "/final") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("payload");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("returns the final post-redirect URL, not the dialed one", async () => {
    const { text, finalUrl } = await guardedFetchTextFinal(`${base}/moved`, { allowPrivate: true });
    expect(text).toBe("payload");
    expect(finalUrl).toBe(`${base}/final`);
  });
});

// ── serve — Link headers on /mcp and /health ────────────────────────────

describe("HTTP serve — RFC 8288 Link headers", () => {
  let server: http.Server;
  let dir: string;
  const PORT = 19879;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kcp-serving-"));
    writeFileSync(join(dir, "guide.md"), "# Guide\n");
    writeFileSync(
      join(dir, "knowledge.yaml"),
      `
project: linked-project
version: 1.0.0
kcp_version: "0.26"
serving:
  manifest: ["https://docs.example.com/knowledge.yaml"]
  mcp: ["https://mcp.example.com/mcp"]
signing:
  scheme: ed25519
  signature: knowledge.yaml.sig
  public_key: https://docs.example.com/keys/kcp.pub
units:
  - id: guide
    path: guide.md
    intent: "How to deploy"
    audience: [agent]
    triggers: [deploy]
`
    );
    server = startServer(PORT, { defaultManifest: dir, publicUrl: "https://mcp.example.com/mcp" });
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.on("listening", resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  });

  function get(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: PORT, method: "GET", path }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("GET /health carries the knowledge-manifest Link relations", async () => {
    const r = await get("/health");
    expect(r.status).toBe(200);
    const link = String(r.headers["link"]);
    expect(link).toContain('<https://docs.example.com/knowledge.yaml>; rel="knowledge-manifest"');
    expect(link).toContain('<https://docs.example.com/knowledge.yaml.sig>; rel="knowledge-manifest-signature"');
    expect(link).toContain('<https://docs.example.com/keys/kcp.pub>; rel="signing-key"');
  });

  it("POST /mcp carries the Link header too", async () => {
    const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: PORT, method: "POST", path: "/mcp", headers: { "Content-Type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      req.end();
    });
    expect(r.status).toBe(200);
    expect(String(r.headers["link"])).toContain('rel="knowledge-manifest"');
  });

  it("exposes Link cross-origin (Access-Control-Expose-Headers)", async () => {
    const r = await get("/health");
    expect(String(r.headers["access-control-expose-headers"])).toContain("Link");
  });

  it("does not attach Link to unrelated endpoints", async () => {
    const r = await get("/nonexistent");
    expect(r.headers["link"]).toBeUndefined();
  });
});
