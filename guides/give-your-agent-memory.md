# Give your agent a memory

Most "agent memory" is an embedding blob: past answers vectorized and retrieved by
similarity. That is exactly the ambient, un-auditable state kcp-agent is built to avoid — it
destroys determinism (plans stop being a pure function of their inputs) and quietly lets
yesterday's model output become today's authority.

kcp-agent's episodic memory is the opposite: **a log of hash-pinned artifacts, recalled by
replay.** A memory here is not a summary — it is the plan or grounded-answer artifact itself,
stripped of the unit bytes and hash-addressed. The tagline:

> A plan is evidence; a memory is a plan you can re-verify against today's world.

See it run first: `node examples/demos.js moved-world`.

## 1. Record an episode

Any `--json` artifact is a memory. Produce one, then `remember` it into a directory:

```bash
kcp-agent ask "who won the exclusive story" --manifest examples/fjordwire --ground --json > ep.json
kcp-agent remember ep.json --memory .kcp-memory
# Remembered grounded-answer 3cfd3d24f2a2… — "who won the exclusive story" (content stripped…)
```

`remember` does two load-bearing things:

- **Strips the unit bytes.** The stored artifact keeps each unit's `id`, `path`, and
  `sha256` — the replay skeleton — and the grounding citation table, but **not** the content.
  Caching a restricted or paid unit's bytes would let a later recall read it without
  re-passing the access gate; that would be a privilege-escalation-through-memory bug. So the
  bytes never enter the log.
- **Hash-addresses the episode.** The entry's id is the sha256 of its content-stripped
  artifact, so recording the same answer twice is idempotent — one episode, not two.

## 2. Recall by task, verify by replay

```bash
kcp-agent recall "the exclusive story winner" --memory .kcp-memory --replay
```

Recall matches past episodes by **lexical task-term overlap** (the same tokenizer the planner
scores with), ranked by overlap — no embeddings, no similarity model, fully deterministic.

Because the bytes are gone, a recalled episode carries **no freshness claim on its own**.
`--replay` re-verifies each hit against today's world: every cited unit is re-read and its
pinned `sha256` re-checked.

| Status | Meaning |
|--------|---------|
| **valid** | every cited unit still holds its pinned bytes — the answer is as true as when recorded |
| **drifted** | a citation moved (bytes changed, or the unit is gone) — the recall exits 1 |
| **unverifiable** | replay could not run, or you omitted `--replay` — memory never claims a stale answer is fresh |

Without `--replay`, every hit is `unverifiable`. Memory would rather say "I can't confirm
this" than falsely vouch for a stale answer.

## 3. Reuse — a determinism cache that fails closed

Pass `--memory` to `plan` or `ask` directly and the log becomes a cache. A plan is a pure
function of `(manifest bytes, task, options)`, so a prior episode is safe to reuse only if it
matches on **all** of those and still replays clean:

```bash
kcp-agent plan "how do I deploy" --manifest . --memory .kcp-memory   # records + reports determinism
kcp-agent plan "how do I deploy" --manifest . --memory .kcp-memory   # ♻ provably identical to episode …
kcp-agent ask  "how do I deploy" --manifest . --ground --memory .kcp-memory   # reuses a clean grounded answer, skips the model
```

- `plan --memory` reports whether today's manifest is byte-identical to a prior episode
  (**♻ provably identical**) or has **drifted** — a determinism/audit signal, never a silent
  reuse across a sha change.
- `ask --ground --memory` is where reuse pays off: before calling the model it replays a
  cached grounded answer, re-checking every citation's `sha256`. Only if *every* one still
  holds is the stored answer returned with **no model call**; any drift re-computes it.

The cache key includes the effective `--as-of` date and the full capability surface
(`--role`, `--budget`, …), so an unpinned plan is only reuse-eligible within the same day,
and a run under different capabilities is a *different plan* — a miss, not a stale hit. See
`node examples/demos.js deja-vu`.

## Posture notes

- **Explicit, not ambient.** `--memory <dir>` is a declared input, like `--as-of` is for
  time. Memory never runs in the background and never becomes hidden state.
- **Integrity is enforced, not assumed.** Entries are hash-addressed and reuse is
  replay-gated. A forged or edited episode does not replay clean, so it cannot steer a plan.
- **Access is re-checked on recall.** Because bytes are stripped on ingest, recall and reuse
  re-read the units live, through the fetch guard — memory can never bypass the next access
  check.

The store is just a directory of `<id>.json` files — commit it, share it, diff it, or throw
it away. It is data with provenance, not a model you have to trust.
