# Make your repo navigable in 10 minutes

Any repository becomes navigable by KCP agents the moment it carries a `knowledge.yaml`.
This guide takes you from nothing to a manifest that real plans can be run against — and
that stays honest in CI.

## 1. Declare the minimum (2 minutes)

Create `knowledge.yaml` at the repo root:

```yaml
kcp_version: "0.25"
project: my-project
version: 1.0.0
updated: "2026-07-04"

units:
  - id: front-door
    path: README.md
    intent: "What is my-project, how do I install and run it?"
    audience: [agent, human]
    triggers: [overview, getting started, install, usage]

  - id: deploy-guide
    path: docs/deploy.md
    intent: "How releases are deployed to production, and how to roll back"
    audience: [agent, developer]
    triggers: [deploy, release, production, rollback]
```

Rules that matter:

- `path` is **relative** to the manifest, never absolute, never `..` — the linter rejects both.
- `intent` is a **question-shaped sentence**, not a title. It is scored against agent tasks.
- `triggers` are the words agents will actually type, not the nouns in your content.

## 2. Lint it (1 minute)

```bash
npx @cantara/kcp-agent validate .
```

Errors (duplicate ids, unsafe or missing paths, `superseded_by` pointing nowhere) exit 1;
warnings flag declarations that weaken navigation (no triggers, expired units with no successor).

## 3. Test it with real plans (5 minutes)

Run the tasks you expect agents to bring, and read the skip reasons:

```bash
npx @cantara/kcp-agent plan "how do I deploy to production?" --manifest .
npx @cantara/kcp-agent plan "how do I get started?" --manifest .
```

A unit you expected showing `no task-relevance match` means zero lexical overlap between the
task and your intent/triggers. The fix belongs in the manifest: write triggers for the
*questions agents ask* ("where does the compute run", "energy costs"), not the article
vocabulary. The scorer is lexical and deterministic — a unit is only findable through the
words its manifest declares.

You can also iterate in the browser: paste your manifest into the
[playground](https://cantara.github.io/kcp-agent/#playground) and watch
`parseManifest → validateManifest → plan` re-run on every keystroke.

## 4. Publish and keep it honest (2 minutes)

- Serve the manifest at the repo root (raw URL works: agents accept HTTPS locations) or at
  `/.well-known/knowledge.yaml` on your site; a web page can point to it with
  `<link rel="knowledge" href="…/knowledge.yaml">`.
- Add the linter to CI so a broken manifest fails the build:

```yaml
- run: npx @cantara/kcp-agent validate .
```

This repository dogfoods the pattern: its own [`knowledge.yaml`](../knowledge.yaml) declares
the README, source modules, and guides as units, and `test/manifest.test.ts` fails CI if a
declared path stops existing.

## Next

- [Sign your manifest](sign-your-manifest.md) so agents can verify provenance.
- [Wire the planner into Claude Code](wire-mcp-into-claude-code.md) and navigate your repo over MCP.
