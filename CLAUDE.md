# kcp-agent

The reference agent for the [Knowledge Context Protocol](https://github.com/Cantara/knowledge-context-protocol):
given a task and a `knowledge.yaml`, it produces a deterministic, auditable load plan (which
units to load and why, what they cost) and, optionally, answers from only those units.

**Start with `knowledge.yaml`** — this repo dogfoods KCP, so its own manifest is the
agent-navigable map: `node dist/cli.js plan "<your task>" --manifest .`

For the shared conventions on authoring `kind: skill` units (PROFILE.md — `action_scope` as a
firewall rule), see [kcp-skill](https://github.com/Cantara/kcp-skill). Don't copy that
library's content here.

**Local skills** — [`skills/`](skills/), repo-specific procedures:
- `kcp-navigator` — the plan-first, fail-closed navigation discipline for driving this CLI.
- `cut-a-release` — the npm release procedure (version-sync + re-signing gotchas below).

## Gotchas

- **The release version lives in three places, not one**: `package.json`, `knowledge.yaml`
  (`version:`/`updated:`), and `src/mcp.ts`'s `SERVER_INFO` literal (kept as a literal — a
  `package.json` read doesn't survive `deno compile`). Has drifted before; `test/manifest.test.ts`
  / `test/mcp.test.ts` catch it. See `cut-a-release`.
- **`knowledge.yaml` is ed25519-signed** (`knowledge.yaml.sig`). Any edit invalidates the
  signature until `sign-kcp.yml` re-signs it — dispatch it manually against your branch (the
  post-merge trigger is circular for a PR that edits the manifest).
- **Java (`java/`) and Rust (`rust/`) ports version independently**, via their own
  `java-release.yml` / `rust-release.yml`.
- **`test/docs.test.ts` enforces the README `Options` table**: every CLI flag `parseArgs`
  accepts must appear there and in `cli.ts`'s header, or CI fails.
