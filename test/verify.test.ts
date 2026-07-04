// Signature verification against a keypair generated in-test — no fixtures,
// no network. The fetchText hook stands in for key/signature URLs.

import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { verifyManifestText } from "../src/verify.js";
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
});
