# The Summer Plan — a family vacation the agent can defend

The **Larsen family** books a week on **Fjordholm** (fictional archipelago):
an eight-year-old with a severe nut allergy, a grandmother who uses a
wheelchair, a teenager gone vegan, and a hard budget. Travel is where every
vibes-based agent demo lives — and where the failure modes are a child's
allergy and a grandmother stranded at a dock. This directory is the knowledge
landscape their travel agent plans over, as four independent parties publish it:

| Party | Directory | Role | What it exercises |
|---|---|---|---|
| Fjordholm Tourism Board | `tourism/` | Signed regional hub, the agent's entry point | ed25519-signed manifest, `not_for` written correctly, federation refs |
| Fjordholm County Ferries | `ferries/` | Timetable authority | Temporal windows + supersession (§4.22): winter hands over to summer |
| National Accessibility Registry | `registry/` | Verified accessibility declarations | `agent_identity` on the federation edge — registered agents only |
| Fjord Safari Co. | `safari/` | Commercial tour operator | Anonymous-paid x402 (§4.11), budget arithmetic in skip reasons |

Everything here is fictional: places, businesses, and measurements.

## Run it

```sh
node examples/demos.js summer
```

Or drive it yourself — first without the registry credential and with a
too-tight budget:

```sh
kcp-agent plan "wheelchair accessible cabin near the ferry, nut allergy safe dining, and a fjord safari for the kids" \
  --manifest examples/summer/tourism --follow --as-of 2026-07-12 \
  --methods free,x402 --budget 0.10
```

Then provisioned like a real family agent:

```sh
kcp-agent plan "wheelchair accessible cabin near the ferry, nut allergy safe dining, and a fjord safari for the kids" \
  --manifest examples/summer/tourism --follow --as-of 2026-07-12 \
  --methods free,x402 --budget 0.60 --credentials registry_pat
```

The point: the safety-critical knowledge — allergy certification,
accessibility declarations, the timetable that decides whether the family
makes the last sailing — travels with signatures, validity windows,
credentials and prices that the planner enforces deterministically, with
every closed gate carrying a written reason.

The demo's third act rewrites the allergen unit's `not_for` as a negation of
its own topic ("questions **not** about nut-free or allergen dining") — the
authoring bug that deterministically hides the allergy unit from exactly the
family that needs it. The plan shows the written skip; `kcp-agent validate`
(the 0.4.0 lint) catches it before publication.

The tourism hub's manifest is signed; re-seal after editing it:

```sh
node scripts/seal-example.mjs examples/summer/tourism/knowledge.yaml tourism-2026
```
