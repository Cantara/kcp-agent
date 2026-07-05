// Signature verification against a keypair generated in-test — no fixtures,
// no network. The fetchText hook stands in for key/signature URLs.

import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { verifyManifestText } from "../src/verify.js";
import { parseManifest } from "../src/client.js";
import type { Signing } from "../src/model.js";

const MANIFEST_TEXT = `project: signed\nversion: 1.0.0\nunits: []\n`;

let publicKeySpkiB64: string;
let signatureB64: string;

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  publicKeySpkiB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  signatureB64 = edSign(null, Buffer.from(MANIFEST_TEXT, "utf8"), privateKey).toString("base64");
});

const files = (map: Record<string, string>) => async (loc: string) => {
  if (loc in map) return map[loc];
  throw new Error(`not found: ${loc}`);
};

// Separate keypair for the legacy-layout test so its manifest can embed the
// public key inline (the key must exist before the manifest text is built).
const legacyPair = generateKeyPairSync("ed25519");
const legacyPrivateKey = legacyPair.privateKey;
const legacyPublicKeyB64 = () => legacyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64");

describe("verifyManifestText", () => {
  it("reports unsigned when there is no signing block", async () => {
    const r = await verifyManifestText(MANIFEST_TEXT, undefined, undefined);
    expect(r.status).toBe("unsigned");
  });

  it("verifies a JSON signature envelope with embedded key (the Cantara convention)", async () => {
    const signing: Signing = { scheme: "ed25519", signature: "https://x.example/m.sig" };
    const envelope = JSON.stringify({
      key_id: "test-2026",
      algorithm: "EdDSA",
      public_key: publicKeySpkiB64,
      signature: signatureB64,
    });
    const r = await verifyManifestText(MANIFEST_TEXT, signing, "https://x.example/knowledge.yaml", {
      fetchText: files({ "https://x.example/m.sig": envelope }),
    });
    expect(r.status).toBe("verified");
    expect(r.keyId).toBe("test-2026");
  });

  it("verifies a raw base64 signature with a separately declared key", async () => {
    const signing: Signing = {
      scheme: "ed25519",
      public_key: "https://x.example/key.pub",
      signature: "https://x.example/m.sig",
    };
    const r = await verifyManifestText(MANIFEST_TEXT, signing, "https://x.example/knowledge.yaml", {
      fetchText: files({
        "https://x.example/key.pub": publicKeySpkiB64,
        "https://x.example/m.sig": signatureB64,
      }),
    });
    expect(r.status).toBe("verified");
  });

  it("resolves signature locations relative to the manifest source", async () => {
    const signing: Signing = { scheme: "ed25519", signature: "knowledge.yaml.sig" };
    const envelope = JSON.stringify({ algorithm: "EdDSA", public_key: publicKeySpkiB64, signature: signatureB64 });
    const r = await verifyManifestText(MANIFEST_TEXT, signing, "https://x.example/kb/knowledge.yaml", {
      fetchText: files({ "https://x.example/kb/knowledge.yaml.sig": envelope }),
    });
    expect(r.status).toBe("verified");
  });

  it("fails closed on tampered content", async () => {
    const signing: Signing = { scheme: "ed25519", signature: "https://x.example/m.sig" };
    const envelope = JSON.stringify({ algorithm: "EdDSA", public_key: publicKeySpkiB64, signature: signatureB64 });
    const r = await verifyManifestText(MANIFEST_TEXT + "units_appended: true\n", signing, undefined, {
      fetchText: files({ "https://x.example/m.sig": envelope }),
    });
    expect(r.status).toBe("invalid");
  });

  it("a pinned trusted key overrides the envelope key", async () => {
    const { publicKey: otherPub } = generateKeyPairSync("ed25519");
    const otherKeyB64 = otherPub.export({ type: "spki", format: "der" }).toString("base64");
    const signing: Signing = { scheme: "ed25519", signature: "https://x.example/m.sig" };
    const envelope = JSON.stringify({ algorithm: "EdDSA", public_key: publicKeySpkiB64, signature: signatureB64 });
    const r = await verifyManifestText(MANIFEST_TEXT, signing, undefined, {
      trustedKey: otherKeyB64, // signed with a DIFFERENT key — pin must reject
      fetchText: files({ "https://x.example/m.sig": envelope }),
    });
    expect(r.status).toBe("invalid");
  });

  it("tolerates a missing trailing newline (end-of-file normalization only)", async () => {
    const signing: Signing = { scheme: "ed25519", signature: "https://x.example/m.sig" };
    const envelope = JSON.stringify({ algorithm: "EdDSA", public_key: publicKeySpkiB64, signature: signatureB64 });
    const r = await verifyManifestText(MANIFEST_TEXT.trimEnd(), signing, undefined, {
      fetchText: files({ "https://x.example/m.sig": envelope }),
    });
    expect(r.status).toBe("verified");
  });

  it("reports unverifiable when the signature cannot be fetched", async () => {
    const signing: Signing = { scheme: "ed25519", signature: "https://x.example/gone.sig" };
    const r = await verifyManifestText(MANIFEST_TEXT, signing, undefined, { fetchText: files({}) });
    expect(r.status).toBe("unverifiable");
  });

  it("reports unverifiable for an unsupported scheme", async () => {
    const signing: Signing = { scheme: "rsa-4096", signature: "sig" };
    const r = await verifyManifestText(MANIFEST_TEXT, signing, undefined, { fetchText: files({}) });
    expect(r.status).toBe("unverifiable");
  });

  it("reports unverifiable (not unsigned) for a signing block with no signature location", async () => {
    // Fail-closed on version skew: a declared-but-unactionable signing block
    // must not silently downgrade to "unsigned" — --require-signature must refuse.
    const signing: Signing = { scheme: "ed25519", key_id: "totto@exoreaction.com" };
    const r = await verifyManifestText(MANIFEST_TEXT, signing, undefined, { fetchText: files({}) });
    expect(r.status).toBe("unverifiable");
    expect(r.keyId).toBe("totto@exoreaction.com");
  });

  it("verifies a KCP ≤0.20 manifest signed under trust.content_integrity", async () => {
    // The legacy layout: signing nested in trust.content_integrity with
    // {algorithm, key_id, public_key} and a sibling signature_file.
    const legacyText =
      `project: legacy\n` +
      `version: 1.0.0\n` +
      `kcp_version: "0.20"\n` +
      `units: []\n` +
      `trust:\n` +
      `  content_integrity:\n` +
      `    signature_file: knowledge.yaml.sig\n` +
      `    signing:\n` +
      `      algorithm: EdDSA\n` +
      `      key_id: legacy-key\n` +
      `      public_key: ${legacyPublicKeyB64()}\n`;
    const manifest = parseManifest(legacyText, "https://x.example/knowledge.yaml");
    expect(manifest.signing?.signature).toBe("knowledge.yaml.sig");
    const sig = edSign(null, Buffer.from(legacyText, "utf8"), legacyPrivateKey).toString("base64");
    const r = await verifyManifestText(legacyText, manifest.signing, manifest.source, {
      fetchText: files({ "https://x.example/knowledge.yaml.sig": sig }),
    });
    expect(r.status).toBe("verified");
    expect(r.keyId).toBe("legacy-key");
  });
});
