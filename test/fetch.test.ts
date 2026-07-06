// Network-boundary hardening (the red-team batch): the guarded fetch that
// every remote path funnels through, and the fan-out ceiling on planTree.
// A local capture server role-plays an internal endpoint — nothing external
// is touched; every URL is 127.0.0.1.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { guardedFetchText, isPrivateAddress, DEFAULT_MAX_NODES } from "../src/index.js";
import { planTree } from "../src/follow.js";
import { verifyManifestText } from "../src/verify.js";

describe("isPrivateAddress", () => {
  it("flags loopback, private, link-local, CGNAT, and cloud metadata", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true); // IPv4-mapped metadata
  });
  it("permits public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("guardedFetchText", () => {
  let server: http.Server;
  let base: string;
  let hits: string[];
  let bigBytes: number;

  beforeAll(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/ok") { res.writeHead(200); res.end("hello"); return; }
      if (req.url === "/huge") {
        res.writeHead(200, { "content-length": String(bigBytes) });
        res.end("x".repeat(bigBytes));
        return;
      }
      if (req.url === "/stream") {
        // No content-length; stream past the cap.
        res.writeHead(200);
        res.write("y".repeat(1024 * 1024));
        res.write("y".repeat(1024 * 1024));
        res.end();
        return;
      }
      if (req.url === "/redirect-scheme") { res.writeHead(302, { location: "ftp://evil.example/x" }); res.end(); return; }
      if (req.url === "/redirect-private") { res.writeHead(302, { location: "http://169.254.169.254/latest" }); res.end(); return; }
      res.writeHead(404); res.end("no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    bigBytes = 4 * 1024 * 1024;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("refuses a loopback host by default (SSRF fail-closed)", async () => {
    await expect(guardedFetchText(`${base}/ok`)).rejects.toThrow(/private\/loopback\/link-local/);
  });

  it("permits loopback only with allowPrivate", async () => {
    expect(await guardedFetchText(`${base}/ok`, { allowPrivate: true })).toBe("hello");
  });

  it("refuses non-http(s) schemes", async () => {
    await expect(guardedFetchText("file:///etc/passwd", { allowPrivate: true })).rejects.toThrow(/refused scheme/);
  });

  it("refuses cleartext http:// to a public host", async () => {
    // 8.8.8.8 is public, so the private check passes; the http:// check must still fire.
    await expect(guardedFetchText("http://8.8.8.8/x")).rejects.toThrow(/cleartext http/);
  });

  it("re-checks each redirect target through the guard (never auto-follows)", async () => {
    // allowPrivate lets us reach the loopback server; the 302 target is fed
    // back through assertFetchable, which refuses the non-http scheme — proof
    // that redirect:manual + per-hop re-validation is in force, so a public
    // host cannot bounce the agent into an address the first check would refuse.
    await expect(guardedFetchText(`${base}/redirect-scheme`, { allowPrivate: true })).rejects.toThrow(/refused scheme/);
  });

  it("rejects an oversize body via declared content-length", async () => {
    await expect(guardedFetchText(`${base}/huge`, { allowPrivate: true, maxBytes: 1024 })).rejects.toThrow(/too large/);
  });

  it("rejects an oversize body while streaming (no content-length)", async () => {
    await expect(guardedFetchText(`${base}/stream`, { allowPrivate: true, maxBytes: 1024 })).rejects.toThrow(/too large/);
  });
});

describe("planTree fan-out ceiling", () => {
  let server: http.Server;
  let base: string;
  let leafHits: number;

  beforeAll(async () => {
    leafHits = 0;
    server = http.createServer((req, res) => {
      if (req.url === "/hub") {
        let m = `kcp_version: "0.25"\nproject: hub\nversion: 1.0.0\nunits: []\nmanifests:\n`;
        for (let i = 0; i < 300; i++) m += `  - {id: r${i}, url: "${base}/leaf${i}"}\n`;
        res.writeHead(200); res.end(m); return;
      }
      if (req.url?.startsWith("/leaf")) {
        leafHits++;
        res.writeHead(200); res.end(`kcp_version: "0.25"\nproject: leaf\nversion: 1.0.0\nunits: []\n`);
        return;
      }
      res.writeHead(404); res.end("no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("stops fetching once the total-node cap is reached, fail-closed with a reason", async () => {
    const tree = await planTree(`${base}/hub`, "anything", {
      maxDepth: 1,
      maxNodes: 10,
      noVerify: true,
      fetchGuard: { allowPrivate: true },
    });
    // root + 9 leaves = 10 nodes; the rest are reported, not fetched.
    expect(leafHits).toBe(9);
    const capped = tree.notFollowed.filter((r) => r.reason.includes("max nodes"));
    expect(capped.length).toBe(291);
  });

  it("defaults to a bounded ceiling even when the caller passes none", () => {
    expect(DEFAULT_MAX_NODES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_NODES).toBeLessThanOrEqual(256);
  });
});

describe("verify routes signature/key URLs through the guard", () => {
  it("refuses to fetch a signature from a private address by default", async () => {
    const signing = { scheme: "ed25519" as const, signature: "http://169.254.169.254/sig" };
    const r = await verifyManifestText("project: x\nversion: 1.0.0\n", signing, undefined);
    expect(r.status).toBe("unverifiable");
    expect(r.detail).toMatch(/private\/loopback\/link-local|cannot load signature/);
  });
});
