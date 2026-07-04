#!/usr/bin/env node
// Seal examples/sealed: generate an ed25519 keypair, sign the EXACT bytes of
// knowledge.yaml, and write knowledge.yaml.sig as a JSON envelope with the
// public key embedded (the Cantara convention — self-attesting: strong for
// integrity, weak for identity; pin with --trusted-key to bind identity).
// The private key lives only in this process — re-running re-seals with a
// fresh key.
//
//   node scripts/seal-example.mjs
//
// The committed .sig was produced by this script. The eighth demo ("The Seal")
// verifies the pristine pair, then tampers a copy and watches the agent fail
// closed before planning.

import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "examples", "sealed", "knowledge.yaml");
const SIG = MANIFEST + ".sig";

const text = readFileSync(MANIFEST, "utf8");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const envelope = {
  key_id: "sealed-2026",
  algorithm: "EdDSA",
  public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  signature: sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64"),
};
writeFileSync(SIG, JSON.stringify(envelope, null, 2) + "\n");
console.log(`sealed: ${path.relative(ROOT, SIG)} (key ${envelope.key_id}, ed25519 over ${Buffer.byteLength(text)} bytes)`);
