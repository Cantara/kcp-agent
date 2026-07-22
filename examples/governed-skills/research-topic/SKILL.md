---
name: research-topic
description: Comprehensively research a topic — gather the governed sources, cross-check them, and synthesize a grounded report where every claim cites a source. Read-only and memory-aware. Use as an autonomous agent's safe starting point for any "look into / what do we know about" task.
---

# Research Topic (the read-only bootstrap skill)

**Purpose.** The flagship *safe starting point* for an autonomous agent: when a
task begins with "look into X" or "what do we know about Y", this is the skill
that runs first. It is deliberately **read-only** — it plans, loads, reads,
cross-checks, and remembers, but it changes nothing. That is what makes it the
showcase for governance as an **enabler**: because its `action_scope` names only
read/plan/memory tools and read-only paths, an agent can run it unattended and
trip nothing — the gates *clear the way* instead of standing in it.

**Declared blast radius.** `Read`, `Grep`, `WebFetch`, `kcp_plan`, `kcp_load`,
`kcp_memory_search`, `kcp_memory_remember` over `research/`, `docs/`,
`knowledge/`. No write tool, no side-effecting action — memory writes are the
sole persistence, and they record *findings*, not changes to the world.

## The "++": what makes it more than a fetch

- **Multi-source cross-check** — never a single source; corroborate.
- **Grounded, cited output** — every claim points at a loaded unit.
- **Memory-aware** — recall before researching, remember after.
- **Read-only** — it can inform any decision without being able to *take* one.

## Steps

1. **Recall prior findings first.** `kcp_memory_search` the topic before
   spending a single fetch — a prior brief may already answer it, or narrow it.
   Start from what is already known, not from zero.
2. **Plan, then load governed sources.** `kcp_plan` the research task against
   the available manifests to see which units are eligible, what they cost, and
   what credentials they need *before* fetching; then `kcp_load` (or `Read`/
   `Grep`/`WebFetch`) only the units the plan cleared. Never fetch blind.
3. **Read and cross-check across sources.** Read the loaded units and compare
   them. Where sources agree, note the corroboration; where they conflict, keep
   both and flag the disagreement — do not silently pick one.
4. **Synthesize a grounded report.** Write the report so that **every claim
   cites the loaded unit it came from.** A claim you cannot attribute to a
   source is not a finding — surface it explicitly as a *gap* ("no governed
   source covers Z"), never as an asserted fact.
5. **Remember the key findings.** `kcp_memory_remember` the durable conclusions
   and their citations so the next run starts from step 1 with more than this
   one did. This is the only thing the skill persists — and it persists
   knowledge, not side effects.
