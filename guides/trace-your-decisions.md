# Trace your decisions

The planner is deterministic, but the cascade it walks is not obvious from the plan
alone. A plan tells you *what* was selected and *what* was skipped. A trace tells you
*why* — gate by gate, for every unit in the manifest. A diff tells you *what changed*
between two plans and where to look.

## 1. Run a plan with `--trace`

Add `--trace` to any `plan` command. The plan prints first (identical to a normal run),
followed by the full gate cascade:

```bash
node dist/cli.js plan "sovereign compute award" \
  --manifest examples/fjordwire --methods free,x402 --trace
```

The output has three sections:

1. **The plan** — the same selected/skipped list you already know.
2. **Gate summary** — how many units passed and failed each gate.
3. **Per-unit cascade** — every gate each unit was evaluated against, in order.

## 2. The 13 gates

Every unit walks through these gates in this order. The first rejection stops
evaluation — later gates are never reached for that unit.

| # | Gate | What it checks |
|---|------|----------------|
| 1 | `audience` | Unit's declared audience includes the agent's role |
| 2 | `not_for` | Unit's `not_for` list does not match the task terms |
| 3 | `temporal` | Unit is active as-of the evaluation date (not future, not expired) |
| 4 | `deprecated` | Unit is not marked deprecated |
| 5 | `supersession` | No active successor exists for this unit |
| 6 | `relevance` | At least one task term matches the unit's intent or triggers |
| 7 | `attestation` | Agent can present required attestation (if any) |
| 8 | `payment` | Agent can afford the unit's payment method |
| 9 | `access` | Agent holds credentials for authenticated/restricted access |
| 10 | `strict` | Unit is load-eligible under `--strict` mode |
| 11 | `max_units` | Unit fits within the `--max-units` cap (greedy by score) |
| 12 | `money_budget` | Unit's price fits within `--budget` ceiling |
| 13 | `context_budget` | Unit's token size fits within `--context-budget` ceiling |

Gates 1-10 are pre-selection: pass/fail per unit in isolation. Gates 11-13 are greedy:
they walk units in score order and reject whichever would blow a cap.

## 3. Read the trace output

Each unit shows a mark (`checkmark` = passed, `cross` = rejected) per gate, then a
detail string:

```
● chipfab-exclusive (score 6) stories/chipfab-exclusive.md
  ✓ audience         role 'agent' in ["agent"]
  ✓ not_for          no not_for declarations
  ✓ temporal         active as-of 2026-07-07
  ✓ deprecated       not deprecated
  ✓ supersession     no supersession declared
  ✓ relevance        score 6: trigger "sovereign" matches …
  ✓ attestation      no attestation required
  ✓ payment          x402: 0.25 USDC
  ✓ access           public access
  ✓ strict           non-strict mode
  ✓ max_units        position 1 within cap of 5
  ✓ money_budget     no budget ceiling set
  ✓ context_budget   no context budget set

○ chipfab-rumour (score 7) stories/chipfab-rumour.md
  ✓ audience         role 'agent' in ["agent"]
  ✓ not_for          no not_for declarations
  ✓ temporal         active as-of 2026-07-07
  ✓ deprecated       not deprecated
  ✗ supersession     superseded by chipfab-exclusive (successor active)
```

The rumour scored higher (7 vs 6) but never reached the relevance gate — supersession
rejected it at gate 5. That is the kind of thing a plan's skip reason tells you, but the
trace shows you exactly where in the cascade it happened and that every prior gate passed.

## 4. Add `--json` for structured traces

```bash
node dist/cli.js plan "sovereign compute award" \
  --manifest examples/fjordwire --methods free,x402 --trace --json > trace.json
```

The JSON contains the full `DecisionTrace` object: `task`, `taskTerms`, `asOf`,
`capabilities`, the canonical `plan`, per-unit `gates` arrays, and `gateSummary`
counts. Feed it to another agent, a dashboard, or an audit log.

## 5. Save two plans and diff them

The `diff` command compares two saved plan artifacts. Save two plans with different
options, then diff:

```bash
# Plan A: agent can pay via x402
node dist/cli.js plan "sovereign compute award" \
  --manifest examples/fjordwire --methods free,x402 --json > plan-a.json

# Plan B: agent can only use free content
node dist/cli.js plan "sovereign compute award" \
  --manifest examples/fjordwire --methods free --json > plan-b.json

# What changed?
node dist/cli.js diff plan-a.json plan-b.json
```

## 6. Read the diff output

The diff reports five kinds of change:

- **Moves** — a unit flipped between selected and skipped (or vice versa).
- **Score changes** — a unit stayed selected but its score shifted.
- **Units added/removed** — a unit exists in one plan but not the other (manifest changed).
- **Budget/context shifts** — projected spend or token usage changed.
- **Reason changes** — a unit stayed skipped but for a different reason.

For the free-vs-x402 comparison above, you will see moves: the paid stories
(`chipfab-exclusive`, `datacenter-power`, `subsea-cable-feature`) were selected in A
and skipped in B because the agent lost the ability to settle x402.

The exit code is `0` when plans are identical, `1` when they differ — wire it into CI
to catch manifest changes that silently alter what an agent loads.

## 7. The MCP `kcp_trace` tool

When running as an MCP server (`kcp-agent mcp`), another agent or IDE can call the
`kcp_trace` tool with the same inputs as `kcp_plan`:

```json
{
  "tool": "kcp_trace",
  "arguments": {
    "task": "sovereign compute award",
    "manifest": "examples/fjordwire",
    "methods": "free,x402"
  }
}
```

The response is the full `DecisionTrace` as JSON — the calling agent can inspect
gate verdicts without parsing terminal output.

## When to use each

| Question | Tool |
|----------|------|
| Why was a specific unit skipped? | `plan --trace` |
| Did a manifest change alter the plan? | `diff` on before/after artifacts |
| Which gate is rejecting the most units? | `plan --trace` gate summary |
| Is the plan identical across environments? | `diff` exit code in CI |
| Let another agent inspect gate logic? | `kcp_trace` over MCP |

## Next

- [Quickstart](quickstart.md) — install and run your first plan.
- [Make your repo navigable](make-your-repo-navigable.md) — publish a manifest that traces can inspect.
- [Wire MCP into Claude Code](wire-mcp-into-claude-code.md) — expose `kcp_trace` to your IDE.
