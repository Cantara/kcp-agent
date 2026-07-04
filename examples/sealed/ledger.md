# The Provenance Ledger

Every entry records what was published, when, and under which key.

| entry | recorded   | key         |
|-------|------------|-------------|
| 1     | 2026-07-01 | sealed-2026 |
| 2     | 2026-07-04 | sealed-2026 |

The manifest describing this ledger is itself sealed: a detached ed25519
signature over its exact bytes. If the manifest and the signature disagree,
the agent refuses to plan — integrity before navigation.
