# Cut context cost with session dedup

When a calling agent uses `kcp_load` over MCP, it gets back the **content** of the units a
deterministic planner selected — and answers from exactly that knowledge. But across a
multi-turn session, the same units get re-sent every turn, re-spending the caller's context
window on bytes it already has.

Session dedup fixes that without making the server stateful. The caller declares what it
already holds; `kcp_load` withholds those bytes and returns a sha-confirmed **stub** instead.

See it run: `node examples/demos.js borrowed-memory`.

## The idea

The calling agent's context window **is** the session state. So kcp-agent stays stateless and
in character: dedup is a *declared input*, not ambient server memory. Pass a `known` array —
the units you already hold, each as `{id, sha256}`:

```jsonc
// tools/call → kcp_load
{
  "task": "how do I deploy and handle an incident?",
  "manifest": "examples/demo-hub",
  "known": [
    { "id": "deploy-guide", "sha256": "…" },
    { "id": "front-door",   "sha256": "…" }
  ]
}
```

For each load-eligible unit, `kcp_load`:

- **withholds the bytes** if `known` lists that id at the **same** sha, returning
  `{ id, path, sha256, unchanged: true, note }` — no content;
- **serves the full content** otherwise.

The response adds `deduped` (the ids withheld) and `bytesSaved` (the characters not re-sent),
so the caller can see the win.

## The one rule that keeps it safe

A stub is emitted **only on an exact sha match**. If your cached copy is stale — the unit
drifted since you last loaded it — the fresh bytes are re-served, never a stub. An `unchanged`
stub is a *literal assertion that the bytes are identical*, not a shortcut that could hide a
change.

And because `kcp_load` re-plans — and therefore re-gates — on every call, a unit you have
since lost access to simply isn't in the loaded set. It is absent, not smuggled back as a
stub. Dedup can never widen what you're allowed to see; it only avoids re-sending what you
already legitimately have.

## Using it from a client

A typical loop:

1. First `kcp_load` with no `known` → you receive full content; record each unit's
   `{id, sha256}`.
2. Next turn, send those back as `known` → matching units return as stubs; `bytesSaved` is
   pure savings on your context window.
3. When a stub *doesn't* come back — a unit re-served in full — its bytes changed; update
   your cached sha and re-read it.

The sha you send is the same one every unit carries in `kcp_load`'s output and in a grounded
answer's citation table, so a client that already tracks citations has everything it needs.

## Posture notes

- **Stateless server.** No session store, no cookies — the caller owns the session, so
  behavior stays a pure function of the request plus the declared `known` set.
- **Composes with grounding.** The withheld unit's `sha256` is exactly what a later
  `kcp-agent replay` or `--ground` citation pins, so dedup never weakens the audit trail.
- **Safe to over-declare.** Claiming to hold a unit you don't just costs you a stub you can't
  use; claiming a wrong sha just gets you the full bytes. There is no failure mode that leaks
  content or bypasses a gate.
