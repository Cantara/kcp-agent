---
name: db-migration-signed
description: Apply a reviewed database schema migration by running the migration runner against the migrations/ directory. Authorized for migrations/ and the db:migrate capability. Its provenance is covered by the manifest's ed25519 signature — an agent should only invoke it from a signature-verified manifest.
---

# DB Migration — signed

**Purpose.** Apply schema migrations — a high-consequence action — from a
manifest whose bytes are cryptographically attested. The signature is what lets
an agent trust that this playbook is the one the publisher wrote, not a
re-hosted copy with an extra "also drop the audit table" step spliced in.

**Declared blast radius.** `Read`, `Bash` over `migrations/`, capability
`db:migrate`. **Provenance:** the containing manifest carries an ed25519
`signing` block; the agent verifies it *before planning*. Change one byte of the
manifest and every plan against it fails closed — see the unsigned twin,
`db-migration-unsigned`.

## Steps

1. **Verify the manifest signature first.** Plan with `--require-signature`. If
   verification fails, stop — do not read or run anything.
2. **Read the pending migrations** under `migrations/`.
3. **Dry-run** the migration runner (`Bash`, `db:migrate`).
4. **Apply** in order, halting on the first failure.
5. **Record** the applied revision. Never touch a path outside `migrations/`.
