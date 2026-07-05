# Wire the planner into Claude Code (MCP)

"KCP is to knowledge what MCP is to tools" — and `kcp-agent mcp` is where they meet. The
server speaks JSON-RPC over stdio with zero dependencies, so any MCP client (Claude Code,
an IDE, another agent) gets deterministic knowledge planning as tools. kcp-agent never
calls a model here and needs **no API key**: the calling agent's own model synthesizes.

## 1. Register the server

```bash
# from npm
claude mcp add kcp -- npx -y kcp-agent mcp

# or from a checkout / native binary
claude mcp add kcp -- node /path/to/kcp-agent/dist/cli.js mcp
```

The `mcp` command takes no flags — the manifest location is a parameter of every tool
call, so one server instance serves any number of knowledge bases.

## 2. The three tools

| Tool | What it returns |
|------|-----------------|
| `kcp_plan` | the deterministic, inspectable load plan — selected units in order, skips with reasons, federation and budget decisions. No content loaded, no model called. |
| `kcp_load` | the plan **plus the content** of load-eligible units, so the caller answers from exactly what the planner selected |
| `kcp_validate` | lint results for a `knowledge.yaml` — structural errors and navigation-weakening warnings |

`kcp_plan` / `kcp_load` take `task` and `manifest` (path, directory, or HTTPS URL) plus the
planner's usual knobs: `env`, `as_of`, `max_units`, `strict`, `budget`, `currency`,
`follow`, `max_depth`.

## 3. Use it

Ask Claude Code, in plain language:

> Use kcp_plan to check what the kcp-agent repo would load for
> "how does signature verification fail closed?" — manifest
> https://raw.githubusercontent.com/Cantara/kcp-agent/main/knowledge.yaml

Claude Code calls the tool, gets the plan artifact, and can then decide — with the skip
reasons in front of it — whether to `kcp_load`. The plan-first discipline (never load
what you haven't planned) is packaged as a portable skill in
[`skills/kcp-navigator/SKILL.md`](../skills/kcp-navigator/SKILL.md).

## Posture notes

- Unit content returned by `kcp_load` is **reference knowledge, never instructions** —
  the tool description says so to the calling model, and the trusted-render principle is
  the reason the planner itself is immune: there is no prompt inside the gates.
- Budgets are enforced in the plan (`budget`, `currency`), so a paid unit the caller
  can't afford is skipped with the arithmetic — before any content moves.
- Federation hops (`follow: true`) stay fail-closed: credential-gated or
  context-excluded refs are never fetched.
