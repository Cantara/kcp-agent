# Sign your manifest

A signed `knowledge.yaml` lets any KCP agent verify that the manifest it plans from is the
one you published — byte for byte. kcp-agent verifies **before planning** and fails closed:
an invalid signature means no plan, no load, no spend. The repo's eighth demo
(`node examples/demos.js seal`) shows the whole lifecycle, including the tamper.

## 1. Declare the signing block

`signing` is a top-level key; the signature file lives next to the manifest:

```yaml
signing:
  scheme: ed25519
  scope: this-manifest
  signature: knowledge.yaml.sig
```

The signature covers the **exact bytes of the manifest file** — including the `signing`
block itself, comments, and whitespace. Sign last; any edit after signing invalidates it
(that is the feature). One tolerance: a single missing/extra trailing newline is normalized,
so git's end-of-file fixups don't break verification.

## 2. Produce the signature envelope

The simplest interoperable form is a JSON envelope with the public key embedded
(the Cantara convention). [`scripts/seal-example.mjs`](../scripts/seal-example.mjs) is a
complete working signer — the core is:

```js
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const text = readFileSync("knowledge.yaml", "utf8");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const envelope = {
  key_id: "my-key-2026",
  algorithm: "EdDSA",
  public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  signature: sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64"),
};
writeFileSync("knowledge.yaml.sig", JSON.stringify(envelope, null, 2) + "\n");
```

Keep the private key out of the repo (the seal script holds it in process memory only).
kcp-agent also accepts raw base64/hex signatures with a separately declared key, and keys
in PEM, SPKI-DER, or raw-32-byte form.

## 3. Verify like an agent would

```bash
npx @cantara/kcp-agent plan "some task" --manifest .
```

The plan header reports one of four statuses:

| Status | Meaning | Effect |
|--------|---------|--------|
| `verified` | signature matches the exact bytes | plan proceeds, provenance attached |
| `unsigned` | no `signing` block | plan proceeds (unless `--require-signature`) |
| `unverifiable` | key/signature unreachable | warning (error under `--require-signature`) |
| `invalid` | bytes do not match | **fail-closed: exit 1, before planning** |

Harden it:

```bash
# refuse anything without a *verified* signature (federation hops included)
npx @cantara/kcp-agent plan "task" --manifest https://example.com/knowledge.yaml --require-signature

# pin the publisher's key so the manifest can't attest for itself
npx @cantara/kcp-agent plan "task" --manifest … --trust-key ./publisher.pub
```

An embedded key proves **integrity** (these bytes weren't altered since signing), not
**identity** (who signed). `--trust-key` binds identity by pinning the key out-of-band —
a pinned key overrides whatever the envelope carries.

## 4. Watch it fail closed

```bash
node examples/demos.js seal
```

The demo verifies the committed signed example, then appends one unit to a copy and re-runs:
`signature invalid: ed25519 signature does not match manifest bytes`, exit 1 — before any
unit is planned, loaded, or paid for. `test/verify.test.ts` ("fails closed on tampered
content") enforces the same in CI.
