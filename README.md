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
discover → verify signature → trust-gate → score units by task → federate (context + agent_identity)
        → temporal filter → budget (payment + rate_limits) → emit load plan → [follow] → [answer]
```

## Install

```bash
npm install
npm run build
```

### Native executables

CI cross-compiles self-contained binaries (no Node/Deno required on the target) for
Linux x64/arm64, macOS x64/arm64, and Windows x64 — grab them from a release or from the
`kcp-agent-natives` artifact on any CI run. To build one yourself:

```bash
npm ci && npm run build
deno compile --allow-read --allow-env --allow-net --node-modules-dir=auto \
  --output kcp-agent dist/cli.js
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

### `ask --loop` — the audited critique loop

```bash
node dist/cli.js ask "who won, and what does it mean for infrastructure?" \
  --manifest ./knowledge.yaml --loop --methods free,x402 --budget 0.50
```

The deterministic scorer is lexical, so a task phrased differently from the publisher's vocabulary
can miss relevant units. `--loop` closes that gap without surrendering determinism — **the model
proposes, the plan disposes**:

```
plan → LLM gap critique (metadata only) → term gate → re-plan → … → load → answer
```

A fast critic model (default `claude-haiku-4-5`, `--loop-model` to change) sees a **metadata
digest** of the plan — ids, intents, scores, skip reasons, never unit content — and proposes extra
lowercase search terms. A deterministic gate sanitizes, dedupes, and caps them; the task string is
extended; the planner re-plans from scratch. The loop converges when the critic runs dry, a round
adds no units, or `--max-rounds` (default 3) is reached. Then synthesis answers the **original**
task from the final plan's eligible units.

What the critic can never do: open an access gate, alter trust/temporal/audience decisions, or
spend money — terms only affect relevance scoring, nothing is loaded or paid for until the loop has
converged, and the final plan's budget arithmetic gates spending exactly as in single-shot mode.
Every round is recorded (proposed terms, accepted, rejected, units added, the full re-planned
artifact) — with `--json` the chain of plans **is** the audit log.

The same loop is available as a library (`runLoop` / `askLoop`, with an injectable critic), and
[`skills/kcp-navigator/SKILL.md`](skills/kcp-navigator/SKILL.md) packages the discipline as a
portable skill for agents that drive the CLI themselves.

### Demos — six scenarios, no mocks

```bash
node examples/demos.js            # all six, narrated
node examples/demos.js --list     # newsstand · transition · vault · org · audit · dogfood
node examples/demos.js vault      # one at a time
```

| Demo | What it shows | Spec |
|------|---------------|------|
| **The Newsstand** | a 0.40 USDC ceiling: buy by score, skip with the arithmetic in the reason | §4.14 |
| **The Transition** | one question, three `--as-of` dates; supersession decides the overlap day | §4.22 |
| **The Vault** | payment never opens an auth gate — x402 in hand, still fail-closed | §4.11/§4.14 |
| **The Org** | federation `context` slices by env; `agent_identity` plans credentials pre-fetch | §3.6 |
| **The Audit** | two `--json` plans diffed: exactly which gate a capability flip moves, and its price | — |
| **The Dogfood** | the agent validates and navigates its own repository | §2 |

Every fact each demo narrates is parsed or computed from the shipping CLI's real output —
nothing is hardcoded — and `test/demos.test.ts` runs all six in CI, so the narration is itself
a regression suite. `plan` and `validate` are offline; no API key needed.

### This repo describes itself

The repository dogfoods KCP: [`knowledge.yaml`](knowledge.yaml) at the root declares the README,
the source modules, the demo manifest, and the CI workflow as knowledge units, and federates to
the [KCP spec](https://github.com/Cantara/knowledge-context-protocol)'s own manifest. So the agent
can navigate its own repo:

```bash
node dist/cli.js plan "how does the planner score units?" --manifest .
```

`test/manifest.test.ts` keeps the manifest honest — parseable, pointing at files that exist, and
planning sensibly.

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
| `--budget <amount>` | spend ceiling for pay-per-request units — greedy by score, skips (with arithmetic) what would blow it |
| `--currency <code>` | budget currency (default `USDC`) |
| `--follow` | fetch and plan eligible federation refs too (fail-closed: gated/excluded refs are never fetched) |
| `--max-depth <n>` | federation hops to follow (default 1; implies `--follow`) |
| `--no-verify` | skip manifest signature verification |
| `--require-signature` | fail unless every manifest has a *verified* signature |
| `--trust-key <loc>` | pinned ed25519 public key (path, URL, or inline) for verification |
| `--json` | emit the plan (and, for `ask`, the answer) as JSON |
| `--model <id>` | (`ask`) Claude model id — default `claude-opus-4-8` |

### `validate` — lint a knowledge.yaml

```bash
node dist/cli.js validate .            # or a path, directory, or URL
```

Errors are structural problems that mislead or fail an agent (duplicate ids, unsafe or missing
paths, `superseded_by` pointing nowhere, attestation requirements no agent can ever satisfy);
warnings are declarations that weaken navigation (no triggers, expired units with no successor).
Exit code 1 on errors — run it in the CI of any repo that publishes a manifest.

### `mcp` — serve the planner to any MCP client

```bash
node dist/cli.js mcp                   # stdio transport
```

Exposes three tools: `kcp_plan` (the inspectable load plan), `kcp_load` (the plan **plus the
content** of load-eligible units, so the calling agent's own model synthesizes — kcp-agent never
needs an API key here), and `kcp_validate`. Register it in e.g. Claude Code:

```bash
claude mcp add kcp -- node /path/to/kcp-agent/dist/cli.js mcp
```

## Signatures

A manifest may declare a `signing` block (scheme `ed25519`, key + detached signature URLs — see
the [spec repo's own manifest](https://github.com/Cantara/knowledge-context-protocol)). When
present, kcp-agent verifies the signature over the exact manifest bytes before planning:
an **invalid** signature always fails closed; an **unverifiable** one (key unreachable) is a
warning unless `--require-signature`. Supported: JSON signature envelopes
(`{algorithm, public_key, signature}`), raw base64/hex signatures, and PEM / SPKI-DER / raw-32-byte
keys. Pin a publisher key with `--trust-key` so the manifest can't attest for itself.

## Writing triggers agents can find

The scorer is **lexical and deterministic** — intent, triggers, and id/path are matched against the
task's terms; there is no model and no embedding. That's the feature (reproducible, auditable,
free), and it has an honest consequence: **a unit is only findable through the words its manifest
declares.** A real miss from the field:

```
task: "sovereign compute award and infrastructure implications"
  · datacenter-power: no task-relevance match      ← the story's best infrastructure angle
```

The unit's triggers were `[datacenter, power grid, capacity, Nordics]` and its intent never said
"infrastructure" — zero lexical overlap, score 0, skipped. The fix belongs in the manifest, not
the planner:

- **Write triggers for the questions agents ask, not the nouns in the content.** "infrastructure",
  "energy costs", "where does the compute run" — the phrasings of tasks — beat article vocabulary.
- **Spend intent words on question terms too**: intent is scored, so "How the power grid limits
  sovereign compute infrastructure" is findable where "Live Nordic datacenter power-grid feed" is not.
- Run `kcp-agent plan` with your expected tasks against your own manifest before publishing —
  the skip reasons show exactly what a real agent would miss and why.

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
- **Federation follower** (`src/follow.ts`) — the async shell around the pure planner: fetches
  eligible refs recursively, fail-closed, with cycle detection and per-hop signature verification.
- **Signature verification** (`src/verify.ts`) — ed25519 over exact manifest bytes via WebCrypto.
- **Synthesis layer** (`src/synthesize.ts`) — the only part that calls a model; loads only the
  planned units and answers the task.
- **MCP server** (`src/mcp.ts`) — dependency-free JSON-RPC over stdio.

## Spec conformance

The agent targets **KCP 0.25** and consumes the subset below end to end. (The spec repo's own
manifest currently declares `kcp_version: 0.21` — the manifests are compatible for these layers.)

| Spec layer | Section | Where |
|------------|---------|-------|
| Query scoring (intent / triggers / id+path) | §15 | `planner.ts` `scoreUnit` |
| Audience & `not_for` targeting | §4 | `planner.ts` audience/negative gates |
| Temporal validity & supersession | §4.22 | `planner.ts` `temporalStatus` |
| Agent attestation requirements | §3.2 | `planner.ts` trust gate |
| Federation `context` + `agent_identity` | §3.6 | `planner.ts` + `follow.ts` |
| Payment methods & tiers | §4.14 | `planner.ts` `planPayment` |
| Rate-limit tiers | §4.15 | `planner.ts` `planBudget` |
| Manifest signing (ed25519) | signing block | `verify.ts` |
| Discovery (`knowledge.yaml`, `.well-known/`) | §2 | `client.ts` |

Not yet consumed: dependency chains between units, `hints.load_strategy`, compliance/audit blocks.

## License

Apache-2.0 · Proposed by [eXOReaction AS](https://www.exoreaction.com), hosted under
[Cantara](https://github.com/Cantara).
