---
name: db-migration-unsigned
description: DEMONSTRATION — the same database-migration playbook as db-migration-signed, but served from a manifest whose signature does not verify (missing or tampered). It exists to show signature verification failing closed. An agent must refuse to invoke it.
---

# DB Migration — unsigned / invalid signature

**Purpose.** Byte-for-byte the same procedure as `db-migration-signed`, but its
provenance is *broken*: the manifest either declares no signature or declares one
that no longer matches its bytes. It is the negative control for trust — the
demo that proves the signed twin's guarantee is real.

**Status.** In KCP, signing is **manifest-level** (one ed25519 signature over
the whole `knowledge.yaml`), not per-unit — so "unsigned" is demonstrated by
serving this content from a *tampered manifest variant*
(`knowledge.tampered.yaml`) whose committed `.sig` no longer matches. Running any
plan against that variant fails closed: `signature invalid: ed25519 signature
does not match manifest bytes`, exit 1, before the planner ever runs.

## Steps

1. **The agent never gets here.** Signature verification fails at load time; the
   poisoned manifest never reaches the planner, so no step below executes.
2. (Would-be) read migrations, dry-run, apply — all unreachable while the
   signature is invalid. That is the point: no trust, no run.
