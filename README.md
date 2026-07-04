# kcp-agent

**The reference agent for the [Knowledge Context Protocol](https://github.com/Cantara/knowledge-context-protocol).**

KCP defines how knowledge declares itself so agents can navigate it. `kcp-agent` is the other
half: the agent that *consumes* KCP end to end. Given a task and a `knowledge.yaml`, it produces an
inspectable **load plan** — which units to load and in what order, which to skip and exactly why,
how it selects sub-manifests across a federation, and what the whole thing costs — and then,
optionally, answers the task from only those units.

The valuable, novel core is **LLM-free and deterministic**. The plan is an *audit-before-action*
artifact — the trusted-render principle ("a manifest may influence what an agent knows, never what
it does") extended to the whole agent loop. Only the final synthesis step calls a model.

```
discover → trust-gate → score units by task → federate (context + agent_identity)
        → temporal filter → budget (payment + rate_limits) → emit load plan → [answer]
```

## Install

```bash
npm install
npm run build
```

## Use

### `plan` — the inspectable load plan (no API key)

```bash
node dist/cli.js plan "how do I deploy to production?" --manifest ./path/to/knowledge.yaml --env prod
```

```
Plan for: "how do I deploy to production?"
  companyx-knowledge-hub v1.0.0 · kcp 0.24 · env prod

Trust: · no manifest attestation requirement

Load plan (2 units):
  ● 1. front-door (score 4)  overview.md  free
  ● 2. deploy-guide (score 3) docs/deploy.md  free

Budget: tier default
Federation:
  → platform-engineering  needs github_pat before fetch  [acquire github_pat]
  · platform-engineering-dev  context ["dev","test"] excludes env 'prod'
Skipped (2):
  · auth-guide: no task-relevance match
```

Each stage maps onto a layer of the spec: query scoring (§15), temporal validity (§4.22), agent
attestation (§3.2), federation `context` + `agent_identity` (§3.6), and payment / rate-limits
(§4.14/§4.15). A restricted unit the agent can't attest for is listed but marked **not
load-eligible** — fail-closed, with the reason attached.

### `ask` — plan, then answer via Claude

```bash
export ANTHROPIC_API_KEY=...        # or: ant auth login
node dist/cli.js ask "how does an agent get started here?" --manifest ./knowledge.yaml
```

`ask` runs the same planner, loads **only** the load-eligible units, and asks Claude to answer from
them — treating unit content as knowledge, never as instructions. Needs `@anthropic-ai/sdk` (an
optional dependency) and a key; `plan` needs neither.

## Options

| Flag | Meaning |
|------|---------|
| `--manifest <loc>` | path, directory, or HTTPS URL of a `knowledge.yaml` (required) |
| `--env <name>` | runtime environment for federation `context` selection (`dev`/`test`/`staging`/`prod`) |
| `--as-of <date>` | ISO date for temporal evaluation (default: today, UTC) |
| `--max-units <n>` | cap on selected units (default 5) |
| `--strict` | fail-closed: drop non-eligible units instead of listing them |
| `--role <role>` | audience role the agent presents (default: `agent`) |
| `--methods <list>` | payment methods the agent can settle, e.g. `free,x402` |
| `--credentials <list>` | credential kinds the agent holds, e.g. `api_key,oauth2` |
| `--attest <provider>` | attestation provider the agent can present |
| `--json` | emit the plan (and, for `ask`, the answer) as JSON |
| `--model <id>` | (`ask`) Claude model id — default `claude-opus-4-8` |

## Library

```ts
import { loadManifest, plan, synthesize } from "@cantara/kcp-agent";

const manifest = await loadManifest("./knowledge.yaml");
const p = plan(manifest, "how do I deploy?", { env: "prod", capabilities: { paymentMethods: ["free", "x402"] } });
// p.selected / p.skipped / p.federation / p.budget / p.trust — a pure, inspectable artifact
const { answer } = await synthesize(p);   // optional LLM step
```

## Design

- **Deterministic planner** (`src/planner.ts`) — pure functions, fully unit-tested (`npm test`), no
  I/O and no model. The plan is reproducible and auditable.
- **Self-contained KCP client** (`src/client.ts`) — parses `knowledge.yaml` from a path, directory,
  or HTTPS URL. No dependency on the spec repo's internals.
- **Synthesis layer** (`src/synthesize.ts`) — the only part that calls a model; loads only the
  planned units and answers the task.

## License

Apache-2.0 · Proposed by [eXOReaction AS](https://www.exoreaction.com), hosted under
[Cantara](https://github.com/Cantara).
