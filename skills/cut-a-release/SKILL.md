---
name: cut-a-release
description: Cut an npm release of kcp-agent (the TypeScript/CLI package) — bump the version in every place the release tests check, re-sign knowledge.yaml, dispatch release.yml, and confirm the npm publish that release.yml hands off to ci.yml. Use when asked to release, publish, or tag a new kcp-agent version. Does NOT cover the separate java-release.yml / rust-release.yml version tracks, which version independently.
---

# Cut a release

## Preconditions

- Working from `main` (or the exact ref you intend to tag), clean tree.
- You know the target version `X.Y.Z` and it's newer than `package.json`'s current version.

## Steps

1. **Bump the version in all three places `npm test` checks — not just `package.json`.**
   `test/manifest.test.ts` and `test/mcp.test.ts` exist *specifically* because this drifted
   before (0.18.0 vs 0.21.0, three releases apart; recurred as a v0.28.0 release blocker).
   Edit, in one commit/PR:
   - `package.json` → `"version"`
   - `knowledge.yaml` → `version:` and `updated:` (today's date)
   - `src/mcp.ts` → the `SERVER_INFO` literal's `version` field (kept as a literal
     deliberately — a runtime `package.json` read doesn't survive `deno compile`, see the
     comment above `SERVER_INFO`)

2. **Re-sign `knowledge.yaml`.** It carries a `signing` block; editing its bytes invalidates
   `knowledge.yaml.sig`, and this repo's own tests verify the signature, so CI on your PR
   will fail until it's re-signed. Dispatch the signer manually against your PR branch —
   don't wait for the post-merge push-triggered path, that's the circular case
   `sign-kcp.yml`'s own comment calls out (the fix can't land until the check it blocks
   passes):

   ```bash
   gh workflow run sign-kcp.yml --ref <your-branch>
   ```

   Pull the resulting commit, confirm `npm test` is green locally, then open/merge the PR.

3. **Dispatch the release workflow from `main` after the version-bump PR is merged.**
   `release.yml` is `workflow_dispatch` only — nothing tags automatically:

   ```bash
   gh workflow run release.yml -f version=vX.Y.Z -f target=main
   ```

   It tags, cross-compiles the five native binaries with Deno, smoke-tests the linux-x64
   binary (`plan` + `validate`), checksums, and creates the GitHub release. It is
   idempotent on the tag step — safe to re-run if a later step failed.

4. **Confirm the npm publish landed.** `release.yml` cannot publish under its own identity
   (npm's OIDC Trusted Publisher only authorizes `ci.yml`'s workflow claim), so its last
   step dispatches `gh workflow run ci.yml --ref main` for you. Check that run went green
   and `npm view kcp-agent version` shows `X.Y.Z`.

## Verification

- `npm view kcp-agent version` == `X.Y.Z`
- GitHub release `vX.Y.Z` exists with 5 native binaries + `SHA256SUMS.txt`
- `node dist/cli.js validate .` passes against the newly-signed `knowledge.yaml`

## Rollback

- If the version-bump PR's CI fails on the manifest-signature test, you skipped step 2 —
  re-sign and push, don't hand-edit `knowledge.yaml.sig`.
- If `release.yml` fails after the tag was pushed, fix and re-run the same
  `gh workflow run release.yml -f version=vX.Y.Z` — the tag step detects the existing tag
  and skips straight to build/release/publish.
- If npm publish fails (`ci.yml` red), the GitHub release and tag already exist; do not
  re-tag — fix the `ci.yml` failure and re-dispatch `gh workflow run ci.yml --ref main`.
