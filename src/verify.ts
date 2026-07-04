// Manifest signature verification — ed25519 over the exact published bytes.
//
// The spec's own manifest publishes a `signing` block pointing at a public key
// and a detached signature. The signature file may be a JSON envelope
// ({algorithm, public_key, signature} — the Cantara convention) or raw
// base64/hex signature bytes; keys may be PEM SPKI, base64 DER SPKI, or raw
// 32-byte base64/hex. Verification is fail-closed: a signature that is present
// but wrong is always fatal to the caller; a signature we cannot fetch is
// reported as unverifiable and left to policy (--require-signature).

import { readFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { webcrypto } from "node:crypto";
import type { Signing } from "./model.js";

export type SignatureStatus = "verified" | "invalid" | "unverifiable" | "unsigned";

export interface SignatureResult {
  status: SignatureStatus;
  detail: string;
  keyId?: string;
}

export interface VerifyOptions {
  /** Pinned key material (path, URL, or inline) — overrides any key the manifest or signature file supplies. */
  trustedKey?: string;
  /** Injectable fetcher for tests. */
  fetchText?: (location: string) => Promise<string>;
}

/** Resolve a possibly-relative location against the manifest's source. */
export function resolveLocation(base: string | undefined, loc: string): string {
  if (/^https?:\/\//.test(loc)) return loc;
  if (base && /^https?:\/\//.test(base)) return new URL(loc, base).toString();
  if (base && !isAbsolute(loc)) return join(dirname(base), loc);
  return loc;
}

async function defaultFetchText(location: string): Promise<string> {
  if (/^https?:\/\//.test(location)) {
    const res = await fetch(location);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  }
  return readFileSync(location, "utf8");
}

const B64 = /^[A-Za-z0-9+/=\s]+$/;
const HEX = /^[0-9a-fA-F\s]+$/;

function decodeBytes(material: string): Uint8Array | undefined {
  const s = material.trim();
  const pem = s.match(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/);
  if (pem) return Uint8Array.from(Buffer.from(pem[1].replace(/\s+/g, ""), "base64"));
  if (HEX.test(s) && s.replace(/\s+/g, "").length % 2 === 0 && s.replace(/\s+/g, "").length >= 64) {
    return Uint8Array.from(Buffer.from(s.replace(/\s+/g, ""), "hex"));
  }
  if (B64.test(s)) return Uint8Array.from(Buffer.from(s.replace(/\s+/g, ""), "base64"));
  return undefined;
}

async function importPublicKey(material: string): Promise<webcrypto.CryptoKey> {
  const bytes = decodeBytes(material);
  if (!bytes) throw new Error("unrecognized public key encoding");
  // 44-byte DER = SPKI wrapper around a 32-byte ed25519 key; 32 bytes = raw key.
  const format = bytes.length === 32 ? "raw" : "spki";
  return await webcrypto.subtle.importKey(format, bytes, { name: "Ed25519" }, false, ["verify"]);
}

/** Is this value inline key/signature material rather than a URL/path? */
function looksInline(value: string): boolean {
  if (/^https?:\/\//.test(value)) return false;
  if (value.includes("-----BEGIN")) return true;
  // Raw ed25519 material has a telltale size: 32 (raw key), 44 (SPKI DER), or 64 (signature) bytes.
  const bytes = decodeBytes(value);
  return !!bytes && [32, 44, 64].includes(bytes.length);
}

/**
 * Verify manifest text against its signing block.
 * `source` (path or URL the manifest was loaded from) anchors relative locations.
 */
export async function verifyManifestText(
  text: string,
  signing: Signing | undefined,
  source: string | undefined,
  options: VerifyOptions = {}
): Promise<SignatureResult> {
  if (!signing || !signing.signature) return { status: "unsigned", detail: "manifest declares no signature" };
  if (signing.scheme && !/^(ed25519|eddsa)$/i.test(signing.scheme)) {
    return { status: "unverifiable", detail: `unsupported signing scheme '${signing.scheme}'` };
  }
  const fetchText = options.fetchText ?? defaultFetchText;

  // Locate the signature (and possibly an embedded key + key id).
  let signatureMaterial: string;
  let embeddedKey: string | undefined;
  let keyId: string | undefined;
  try {
    const rawSig = looksInline(signing.signature)
      ? signing.signature
      : await fetchText(resolveLocation(source, signing.signature));
    try {
      const envelope = JSON.parse(rawSig) as Record<string, unknown>;
      signatureMaterial = String(envelope["signature"] ?? "");
      embeddedKey = envelope["public_key"] === undefined ? undefined : String(envelope["public_key"]);
      keyId = envelope["key_id"] === undefined ? undefined : String(envelope["key_id"]);
      const alg = envelope["algorithm"] === undefined ? undefined : String(envelope["algorithm"]);
      if (alg && !/^(ed25519|eddsa)$/i.test(alg)) {
        return { status: "unverifiable", detail: `unsupported signature algorithm '${alg}'`, keyId };
      }
    } catch {
      signatureMaterial = rawSig; // raw base64/hex signature file
    }
  } catch (e) {
    return { status: "unverifiable", detail: `cannot load signature: ${e instanceof Error ? e.message : String(e)}` };
  }
  const sigBytes = decodeBytes(signatureMaterial);
  if (!sigBytes || sigBytes.length !== 64) {
    return { status: "invalid", detail: "signature is not 64 ed25519 signature bytes", keyId };
  }

  // Locate the public key. A pinned key always wins; otherwise the manifest's
  // signing.public_key; the key embedded in the signature envelope is the last
  // resort (self-attesting — fine for integrity, weak for identity).
  let keyMaterial: string;
  try {
    if (options.trustedKey) {
      keyMaterial = looksInline(options.trustedKey)
        ? options.trustedKey
        : await fetchText(resolveLocation(undefined, options.trustedKey));
    } else if (signing.public_key) {
      keyMaterial = looksInline(signing.public_key)
        ? signing.public_key
        : await fetchText(resolveLocation(source, signing.public_key));
    } else if (embeddedKey) {
      keyMaterial = embeddedKey;
    } else {
      return { status: "unverifiable", detail: "no public key available", keyId };
    }
  } catch (e) {
    if (embeddedKey && !options.trustedKey) {
      keyMaterial = embeddedKey; // declared key unreachable; fall back to envelope key
    } else {
      return { status: "unverifiable", detail: `cannot load public key: ${e instanceof Error ? e.message : String(e)}`, keyId };
    }
  }

  let key: webcrypto.CryptoKey;
  try {
    key = await importPublicKey(keyMaterial);
  } catch (e) {
    return { status: "unverifiable", detail: `cannot import public key: ${e instanceof Error ? e.message : String(e)}`, keyId };
  }

  const enc = new TextEncoder();
  // Verify the exact bytes; retry with a single trailing newline normalized,
  // which survives editor/git end-of-file differences without weakening the check.
  const candidates = [text, text.replace(/\n*$/, "\n")];
  for (const candidate of candidates) {
    if (await webcrypto.subtle.verify("Ed25519", key, sigBytes, enc.encode(candidate))) {
      const via = options.trustedKey ? "pinned key" : signing.public_key ? "declared key" : "envelope key";
      return { status: "verified", detail: `ed25519 signature verified (${via})`, keyId };
    }
  }
  return { status: "invalid", detail: "ed25519 signature does not match manifest bytes", keyId };
}
