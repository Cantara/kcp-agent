// Guarded network reads — the fetch every remote path funnels through.
//
// A manifest is untrusted input, and it chooses URLs the agent then fetches:
// federation refs, signature and public-key locations, remote unit content.
// Left bare, `fetch()` makes the agent a confused deputy — it will read
// http:// cleartext, reach cloud-metadata and internal addresses, follow a
// redirect from a public host into a private one, and pull an unbounded body
// into memory. This helper closes all four, fail-closed by default:
//
//   • scheme:   https only for remote (http allowed solely to loopback, and
//               only when private hosts are explicitly permitted)
//   • host:     every resolved address is checked; private, loopback, and
//               link-local ranges are refused unless allowPrivate is set
//   • redirect: manual — each hop's Location is re-checked, never auto-followed
//               into an address the first check would have refused
//   • size:     the body is streamed against a byte ceiling and aborted over it
//   • time:     an AbortSignal caps the whole exchange
//
// The planner's fail-closed discipline reaches the socket here.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface FetchGuard {
  /** Permit loopback / private / link-local hosts (and http:// to loopback). Default false. */
  allowPrivate?: boolean;
  /** Max response bytes before the read is aborted. Default 8 MiB. */
  maxBytes?: number;
  /** Whole-exchange timeout in ms. Default 15000. */
  timeoutMs?: number;
}

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

/** True for IPv4/IPv6 literals that must never be reached from an untrusted manifest. */
export function isPrivateAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) return isPrivateV4(addr);
  if (kind === 6) return isPrivateV6(addr.toLowerCase());
  return false;
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → refuse
  const [a, b] = p;
  return (
    a === 0 || // 0.0.0.0/8 "this host"
    a === 10 || // private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a >= 224 // multicast / reserved
  );
}

function isPrivateV6(ip: string): boolean {
  // Normalize IPv4-mapped (::ffff:a.b.c.d) and route it through the v4 check.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return (
    ip === "::1" || // loopback
    ip === "::" || // unspecified
    ip.startsWith("fe80") || // link-local
    ip.startsWith("fc") || // unique-local fc00::/7
    ip.startsWith("fd") ||
    ip.startsWith("ff") // multicast
  );
}

/** Refuse a URL whose scheme/host an untrusted manifest must not reach. Returns the checked URL. */
async function assertFetchable(rawUrl: string, guard: FetchGuard): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`refused scheme '${url.protocol}' (only http/https are fetched)`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Resolve the host to every address it would connect to, and check them all.
  // A literal IP is checked directly; a name is resolved (this also means the
  // address a later connect() uses is one we've inspected).
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((r) => r.address);
    } catch (e) {
      throw new Error(`cannot resolve host '${host}': ${e instanceof Error ? e.message : String(e)}`);
    }
    if (addresses.length === 0) throw new Error(`host '${host}' resolved to no addresses`);
  }

  if (!guard.allowPrivate) {
    const blocked = addresses.find(isPrivateAddress);
    if (blocked) {
      throw new Error(
        `refused private/loopback/link-local address ${blocked} for '${host}' ` +
          `(pass --allow-private-hosts to permit local and internal manifests)`
      );
    }
    if (url.protocol === "http:") {
      throw new Error(`refused cleartext http:// for '${host}' (use https, or --allow-private-hosts for local)`);
    }
  }
  return url;
}

/** Fetch text from a URL through the guard: scheme + host + redirect + size + time. */
export async function guardedFetchText(rawUrl: string, guard: FetchGuard = {}): Promise<string> {
  const maxBytes = guard.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = guard.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertFetchable(current, guard);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });

    // Manual redirect handling: re-check every hop's target against the guard,
    // so a public host can't bounce the agent into a private one.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect with no Location from ${url.href}`);
      current = new URL(loc, url).href;
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    // Reject an oversize body up front when the server declares it...
    const declared = Number(res.headers.get("content-length"));
    if (!Number.isNaN(declared) && declared > maxBytes) {
      throw new Error(`response too large: ${declared} bytes exceeds cap ${maxBytes}`);
    }
    // ...and enforce the ceiling while streaming, for servers that don't (or lie).
    return await readCapped(res, maxBytes, url.href);
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS}) starting at ${rawUrl}`);
}

async function readCapped(res: Response, maxBytes: number, href: string): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`response too large: exceeded cap ${maxBytes} bytes while reading ${href}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
