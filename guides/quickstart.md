# Quickstart — your first ten minutes with kcp-agent

kcp-agent is a reference agent for the [Knowledge Context Protocol](https://github.com/Cantara/knowledge-context-protocol):
given a task and a `knowledge.yaml`, it produces a **deterministic, fail-closed, auditable
load plan** — which knowledge units to load, in what order, and which to skip with a written
reason. This walkthrough gets you from install to a signed, replayable answer. Everything here
is offline and needs **no API key**, except the one `ask` step (which calls Claude).

## 0. Install

```bash
npx kcp-agent --help          # no install
# or
npm i -g kcp-agent            # global CLI
# or grab a native binary from the GitHub Releases page (no Node needed)
```

The rest of this guide runs against the example manifests in a checkout, so clone if you want
to follow along verbatim:

```bash
git clone https://github.com/Cantara/kcp-agent && cd kcp-agent && npm i && npm run build
```

## 1. Plan — the inspectable core (no model)

`plan` is the whole point: a pure function from task + manifest to a load plan. No content is
fetched, no model is called.

```bash
node dist/cli.js plan "how do I deploy?" --manifest examples/demo-hub --env prod
```

You get a ranked list of selected units (`●`) and skipped ones (`○`) — **every skip carries a
sentence you could read to an auditor**: over budget with the arithmetic, gated by audience,
expired and superseded, needs a credential before fetch. That written-reason discipline is the
product.

Try the knobs — each maps to a gate the planner enforces:

```bash
node dist/cli.js plan "quarterly board numbers" --manifest examples/vault                 # restricted → fail-closed
node dist/cli.js plan "quarterly board numbers" --manifest examples/vault --credentials mtls   # gate opens
node dist/cli.js plan "buy the exclusive"        --manifest examples/fjordwire --budget 0.4 --methods free,x402
node dist/cli.js plan "sovereign compute award"  --manifest examples/fjordwire --context-budget 3000 --methods free,x402   # a token ceiling
```

**`--context-budget <n>`** budgets the actually-scarce resource when feeding a model: tokens. It
works exactly like `--budget` but in tokens — greedy by score, and a unit that would blow the
ceiling is skipped with the arithmetic (`over context budget: 900 tokens would exceed remaining
100 of 3,000`), while a smaller one still fits. A unit's size comes from a declared `size_tokens`
or `bytes/4`, weighed on metadata *before* any fetch. It composes with `--budget` — a unit must fit
both. See the *Context Window* demo (`node examples/demos.js context-window`).

Add `--json` and the plan becomes an artifact that pins the manifest's `sha256` and echoes
every input — keep it; step 5 cross-examines it.

## 2. Ask — plan, then answer (needs an API key)

`ask` runs the same plan, loads the eligible units, and has Claude synthesize an answer from
exactly that knowledge:

```bash
export ANTHROPIC_API_KEY=sk-…
node dist/cli.js ask "how do I deploy?" --manifest examples/demo-hub --env prod
```

Add `--ground` to hold the *output* to the same standard as the plan: each claim must be
attributed to a loaded, hash-pinned unit, or it is surfaced as an explicit **gap** — never
silently dropped.

## 3. Validate — keep a manifest honest

```bash
node dist/cli.js validate examples/demo-hub
```

Errors are structural problems that would mislead an agent (duplicate ids, unsafe paths,
`superseded_by` pointing nowhere); warnings are declarations that weaken navigation. Exit code
1 on errors — run it in the CI of any repo that publishes a manifest.

## 4. Serve it over MCP — no key needed

```bash
node dist/cli.js mcp
```

Any MCP client (Claude Code, an IDE, another agent) now gets `kcp_plan`, `kcp_load`,
`kcp_validate`, and `kcp_replay` as tools. The caller's own model synthesizes, so kcp-agent
never spends your tokens. Full walkthrough:
[wire-mcp-into-claude-code.md](wire-mcp-into-claude-code.md).

## 5. Replay — a plan is evidence, replay is the cross-examination

```bash
node dist/cli.js plan "how do I deploy?" --manifest examples/demo-hub --env prod --json > plan.json
node dist/cli.js replay plan.json         # exit 0 identical · exit 1 drifted
```

`replay` re-fetches the manifest, re-hashes the bytes, re-runs the pure planner from the saved
inputs, and reports **identical** or **drifted** with the fields that moved. Editing the
artifact by hand is drift too — the recomputed plan won't match it.

## Where to go next

- **See it all run:** `node examples/demos.js` — seventeen narrated, offline scenarios, each a
  regression test.
- **Publish your own manifest:** [make-your-repo-navigable.md](make-your-repo-navigable.md).
- **Sign it:** [sign-your-manifest.md](sign-your-manifest.md) — ed25519 over exact bytes,
  fail-closed on tamper.
- **Give the agent a memory:** [give-your-agent-memory.md](give-your-agent-memory.md) —
  record answers as replayable, byte-free episodes and reuse them only while they still hold.
- **Cut a caller's context bill:** [cut-context-cost-with-dedup.md](cut-context-cost-with-dedup.md).
- **Port the planner:** [build-a-conformant-implementation.md](build-a-conformant-implementation.md)
  — the deterministic core is a pure function; validate a second implementation against the vectors.

The theme throughout: **the deterministic planner is the environment, the model is a
constrained proposer.** A manifest may influence what an agent knows, never what it does.
