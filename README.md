# kcp-agent

**The reference agent for the [Knowledge Context Protocol](https://github.com/Cantara/knowledge-context-protocol).**

> **[The Arena →](https://cantara.github.io/kcp-agent/)** — the real planner, bundled unmodified,
> running live in your browser, head-to-head against the usual suspects. *The most deterministic
> agents in the world. Every decision defensible.*

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

### `ask --ground` — verify the answer, surface what it can't substantiate

```bash
node dist/cli.js ask "who won, and what does it mean?" --manifest ./knowledge.yaml --ground
```

The plan's fail-closed gates decide what may be *loaded*; grounding extends the same discipline to
what may be *asserted*. After synthesis, each claim in the answer is checked by a **separate
verifier** — a distinct model call from the generator — that must attribute the claim to one of the
loaded units or return nothing. The result is a two-part artifact:

```
Grounded (2/3 claims):
  ● The award went to the Nordic bid.
     ↳ chipfab-exclusive · sha 9f2c1a0b7e34
Unsubstantiated (1): — could not be grounded in a loaded unit
  ○ The datacenter runs on hydro power.
     no loaded unit supports this claim
⚠ partial-unsupported — 1 claim(s) could not be substantiated
```

A claim grounds **only** if the cited unit was actually loaded and its content hash matches — so a
verifier that mis-attributes (or is prompt-injected into) citing a unit that was never loaded can
never ground a claim: attribution is a proposal, grounding is adjudicated. Unsupported claims are
**surfaced, never silently dropped** — the honest half of "every decision defensible". Each surfaced
gap is also a signal to the *publisher*: the task needed evidence the manifest didn't provide. The
surfaced list is capped to guard against a compromised generator flooding it with spurious gaps.

**`--ground-rounds <n>`** closes the loop: a surfaced gap seeds reformulation terms, the agent
re-navigates to try to find the missing evidence, and re-grounds — up to `n` rounds. Termination is
guaranteed by three independent bounds, any one of which halts: the term gate is **absorbing** (a
term accepted once is known forever, so re-navigation can only add units from the finite eligible
set), the **round cap**, and a **progress guard** (a round that adds no new unit halts). Oscillation
is impossible — the loaded set grows monotonically or the loop stops. Every terminal state that
isn't `grounded` (`partial-unsupported`, `partial-budget`, `partial-rounds`) still **surfaces** the
remaining gaps. A compromised verifier can, at worst, widen navigation within the eligible set — it
can never cross a gate, name a URL, or spend past the budget.

### Demos — thirteen scenarios, no mocks

```bash
node examples/demos.js            # all thirteen, narrated
node examples/demos.js --list     # newsstand · transition · vault · org · audit · loop · grounding · seal · incident · leash · summer · milky-way · dogfood
node examples/demos.js vault      # one at a time
```

| Demo | What it shows | Spec |
|------|---------------|------|
| **The Newsstand** | a 0.40 USDC ceiling: buy by score, skip with the arithmetic in the reason | §4.14 |
| **The Transition** | one question, three `--as-of` dates; supersession decides the overlap day | §4.22 |
| **The Vault** | payment never opens an auth gate — x402 in hand, still fail-closed | §4.11/§4.14 |
| **The Org** | federation `context` slices by env; `agent_identity` plans credentials pre-fetch | §3.6 |
| **The Audit** | two `--json` plans diffed: exactly which gate a capability flip moves, and its price | — |
| **The Loop** | the audited critique loop with a scripted critic: injection bounces, terms re-plan, budget holds | — |
| **The Grounding** | `ask --ground`: a claim citing an unloaded unit fails closed; the closed loop re-navigates and grounds it against real bytes | — |
| **The 03:00 Page** | a zero-day across four federated parties — attestation, a signed CERT, supersession, TLP:AMBER as an enforced gate, an intel budget ([`examples/incident/`](examples/incident/)) | all of it |
| **The Borrowed Leash** | a scripted foreign MCP client replans the incident over stdio — same gates, same ledger — then `kcp_replay` catches its falsified artifact | — |
| **The Seal** | a signed manifest verifies; one unit appended after signing → fail-closed before planning | §3.2 |
| **The Summer Plan** | a family vacation across four federated parties — a signed hub, timetable supersession, an identity-gated accessibility registry, x402 tour detail, and the `not_for` footgun caught by the validate lint ([`examples/summer/`](examples/summer/)) | §3.6/§4.11/§4.22 |
| **The Milky Way** | a whole enterprise documentation estate — a signed hub over eight domains: env-sliced dev mirror, a future regulation dated out, human-only HR docs, HSM-attested formulations, an identity-gated ERP vendor with subscription rate tiers, and a CSRD annual handover ([`examples/milky-way/`](examples/milky-way/)) | §3.6/§4.14/§4.22 |
| **The Dogfood** | the agent validates and navigates its own repository | §2 |

Every fact each demo narrates is parsed or computed from the shipping CLI's and library's real
output — nothing is hardcoded — and `test/demos.test.ts` runs all thirteen in CI, so the narration is
itself a regression suite. Everything is offline; no API key needed.

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
| `--env <name>` | runtime environment for federation `context` selection (`dev`/`test`/`staging`/`prod`). Fail-closed: without it, context-tagged refs are never followed |
| `--as-of <date>` | ISO date for temporal evaluation (default: today, UTC) |
| `--max-units <n>` | cap on selected units (default 5) |
| `--strict` | fail-closed: drop non-eligible units instead of listing them |
| `--role <role>` | audience role the agent presents (default: `agent`) |
| `--methods <list>` | payment methods the agent can settle, e.g. `free,x402` |
| `--credentials <list>` | credential kinds the agent holds, e.g. `api_key,oauth2` |
| `--attest <provider>` | attestation provider the agent can present |
| `--budget <amount>` | spend ceiling for pay-per-request units — greedy by score, skips (with arithmetic) what would blow it. One ceiling for the whole federated walk, not per manifest |
| `--currency <code>` | budget currency (default `USDC`) |
| `--follow` | fetch and plan eligible federation refs too (fail-closed: gated/excluded refs are never fetched) |
| `--max-depth <n>` | federation hops to follow (default 1; implies `--follow`) |
| `--max-nodes <n>` | cap on total manifests fetched across the whole walk (default 64; fail-closed fan-out ceiling) |
| `--allow-private-hosts` | permit fetches to loopback/private/link-local hosts and `http://` — off by default (blocks SSRF into internal/metadata addresses) |
| `--no-verify` | skip manifest signature verification |
| `--require-signature` | fail unless every manifest has a *verified* signature |
| `--trust-key <loc>` | pinned ed25519 public key (path, URL, or inline) for verification |
| `--json` | emit the plan (and, for `ask`, the answer) as JSON |
| `--model <id>` | (`ask`) Claude model id — default `claude-opus-4-8` |
| `--loop` | (`ask`) audited critique loop: plan → LLM gap critique → term gate → re-plan |
| `--max-rounds <n>` | (`ask --loop`) max critique rounds (default 3) |
| `--loop-model <id>` | (`ask --loop`) critic model — default `claude-haiku-4-5` |
| `--ground` | (`ask`) verify each answer claim against a loaded unit; surface unsubstantiated ones |
| `--ground-model <id>` | (`ask --ground`) verifier model — default `claude-haiku-4-5` |
| `--ground-rounds <n>` | (`ask`) closed-loop grounding: a surfaced gap re-navigates for evidence (default 0) |
| `--check-gaps` | (`replay`) re-navigate today's manifest to see if a grounded answer's surfaced gap now closes |
| `--memory <dir>` | (`remember`/`recall`) episodic-memory directory — one hash-addressed entry per artifact |
| `--replay` | (`recall`) re-verify each recalled episode against today's manifests (a drifted hit exits 1) |
| `--limit <n>` | (`recall`) cap the number of episodes returned |

`test/docs.test.ts` keeps this table honest: every flag `parseArgs` accepts must appear here
and in the `cli.ts` header, and vice versa.

### `validate` — lint a knowledge.yaml

```bash
node dist/cli.js validate .            # or a path, directory, or URL
```

Errors are structural problems that mislead or fail an agent (duplicate ids, unsafe or missing
paths, `superseded_by` pointing nowhere, attestation requirements no agent can ever satisfy);
warnings are declarations that weaken navigation (no triggers, expired units with no successor).
Exit code 1 on errors — run it in the CI of any repo that publishes a manifest.

### `replay` — re-verify a saved plan or grounded answer

```bash
node dist/cli.js plan "task" --manifest . --json > plan.json
node dist/cli.js replay plan.json       # exit 0 identical · exit 1 drifted
```

A `plan --json` artifact pins the manifest's sha256 and echoes every planner input. `replay`
re-fetches each manifest (every node of a `--follow` tree), compares the bytes, re-runs the
pure planner with the saved inputs, and reports **identical** or **drifted** — per manifest,
with the fields that moved. A plan is evidence; replay is the cross-examination. Editing the
artifact by hand is also drift: the recomputed plan won't match it.

`replay` auto-detects a **grounded-answer** artifact (from `ask --ground --json`) and
cross-examines it claim-by-claim instead: each grounded claim's cited unit is re-read and its
`sha256` re-compared to the pinned one — **still-grounded**, **drifted** (bytes changed), or
**gone** (unit removed) — exit 1 if any citation no longer holds, because a stale answer must
not read as verified. With `--check-gaps` it re-navigates today's manifest to see whether a
previously-surfaced gap now **closes** (the manifest grew the missing evidence since the answer)
— gaps have a lifecycle, and a memory is a plan you can re-verify against a moved world.

### `remember` / `recall` — episodic memory as replayable plans

```bash
node dist/cli.js ask "who won the exclusive story" --manifest examples/fjordwire --ground --json > ans.json
node dist/cli.js remember ans.json --memory .kcp-memory        # log the episode (unit bytes stripped)
node dist/cli.js recall "the exclusive story winner" --memory .kcp-memory --replay
```

A memory here is not a summary or an embedding — it is the plan/grounded-answer artifact itself,
**stripped of the one thing that would make it dangerous to keep: the unit bytes.** Caching
restricted or paid content in the memory log would let a later recall read it without re-passing
the access gate, so `remember` keeps only what replay needs — each unit's `id`, `path`, `sha256`,
and the citation table — and drops every `content` field. Entries are hash-addressed by their
content-stripped artifact, so recording the same answer twice is idempotent.

`recall` matches past episodes by lexical task-term overlap (the same tokenizer the planner
scores with), ranked by overlap. Because the bytes are gone, a recalled episode carries **no
freshness claim on its own**: with `--replay` each hit is re-verified against today's manifests —
**valid** (every cited unit holds its pinned bytes), **drifted** (a citation moved — exit 1), or
**unverifiable** (the replay could not run). Without `--replay`, every hit is reported
`unverifiable` — memory never falsely claims a stale answer is still true. A memory is a plan you
can re-verify against a moved world.

### `mcp` — serve the planner to any MCP client

```bash
node dist/cli.js mcp                   # stdio transport
```

Exposes four tools: `kcp_plan` (the inspectable load plan), `kcp_load` (the plan **plus the
content** of load-eligible units, so the calling agent's own model synthesizes — kcp-agent never
needs an API key here), `kcp_validate`, and `kcp_replay` (cross-examine a saved plan artifact
over the wire). `kcp_plan`/`kcp_load` take the CLI's full capability surface — `role`,
`methods`, `credentials`, `attest`, `budget` — so attestation and credential gates answer for
any MCP client exactly as they do on the command line. The borrowing agent doesn't have to be
deterministic; it just has to ask someone who is. Register it in e.g. Claude Code:

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

## The network boundary

A manifest is untrusted input that *chooses* URLs the agent then fetches — federation refs,
signature and key locations, remote unit content. Every remote read funnels through one guarded
fetch (`src/fetch.ts`), fail-closed by default:

- **SSRF / confused deputy** — `https://` only for remote; loopback, private, link-local, and
  cloud-metadata addresses (e.g. `169.254.169.254`) are refused. Hostnames are DNS-resolved and
  every address checked; redirects are followed manually so a public host can't bounce the agent
  into a private one. `--allow-private-hosts` opts in for local/internal manifests.
- **Fan-out** — depth and cycles were already bounded; `--max-nodes` (default 64) now caps the
  *total* manifests a single `--follow` will fetch, so one hostile hub can't fan out to millions.
- **Response size** — every read is streamed against an 8 MiB ceiling and aborted past it, with a
  whole-exchange timeout, so a hostile endpoint can't exhaust memory.

Over MCP the guard is on by default — a foreign client is exactly the untrusted-caller case.

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
import { loadManifest, plan, synthesize } from "kcp-agent";

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
| Access is the auth axis — payment never substitutes | §4.11 | `planner.ts` access gate |
| Temporal validity & supersession | §4.22 | `planner.ts` `temporalStatus` |
| Agent attestation requirements | §3.2 | `planner.ts` trust gate |
| Federation `context` + `agent_identity` | §3.6 | `planner.ts` + `follow.ts` |
| Payment methods & tiers | §4.14 | `planner.ts` `planPayment` |
| Rate-limit tiers | §4.15 | `planner.ts` `planBudget` |
| Manifest signing (ed25519) | signing block | `verify.ts` |
| Discovery (`knowledge.yaml`, `.well-known/`) | §2 | `client.ts` |

Every row is pinned to the CI tests that enforce it in
[`docs/conformance.json`](docs/conformance.json) — rendered as
[the Receipts](https://cantara.github.io/kcp-agent/#receipts) on the site — and
`test/docs.test.ts` fails the build if a referenced test disappears or is renamed.

Not yet consumed: dependency chains between units, `hints.load_strategy`, compliance/audit blocks.

## Guides

- [Make your repo navigable in 10 minutes](guides/make-your-repo-navigable.md) — from nothing to a
  manifest real plans run against, kept honest in CI.
- [Sign your manifest](guides/sign-your-manifest.md) — ed25519 over exact bytes, envelopes, key
  pinning, and the fail-closed lifecycle.
- [Wire the planner into Claude Code](guides/wire-mcp-into-claude-code.md) — `kcp_plan` /
  `kcp_load` / `kcp_validate` over MCP, no API key needed.

## License

Apache-2.0 · Proposed by [eXOReaction AS](https://www.exoreaction.com), hosted under
[Cantara](https://github.com/Cantara).
