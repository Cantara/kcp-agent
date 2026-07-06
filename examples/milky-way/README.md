# The Milky Way — an enterprise documentation estate the agent can defend

**Melkeveien SA** (fictional farmer-owned dairy cooperative — *Melkeveien*
is Norwegian for "the Milky Way") publishes its entire documentation estate
as KCP manifests: one signed hub, eight domains, nine manifests, and five
very different agents walking the same knowledge. This is the enterprise
case: not one clever demo gate, but a whole estate where classification,
audiences, validity windows and vendor boundaries are machine-enforced
manifest facts instead of tribal knowledge.

| Domain | Directory | Role | What it exercises |
|---|---|---|---|
| Group Documentation Hub | `hub/` | Signed entry point | ed25519-signed manifest, federation to 8 domains |
| Integration Platform | `it/platform/` | ERP/MES/logistics integrations | Rate-limit tiers, machine-readable OpenAPI unit, ADR supersession chain (§4.22) |
| Dev Mirror | `it/dev-mirror/` | Sandbox + mock data | `context: [dev]` on the federation edge — invisible to prod agents |
| Quality & Food Safety | `quality/` | HACCP, audits | Future regulation with `valid_from: 2027-01-01` — visible, dated, excluded |
| R&D | `recipes/` | Formulations (crown jewels) | `access: restricted` + HSM attestation, `not_for` in the excluded topics' own words |
| People | `people/` | HR processes | `audience: [human]` — the agent is turned away from the salary document |
| Brand & Communications | `brand/` | Press kit, guidelines | Public, CC-BY, where the comms agent legitimately lands |
| Sustainability | `esg/` | CSRD reporting | Annual handover: overlap window disambiguated by `superseded_by` |
| Orion Business Systems | `vendor/` | External ERP vendor | `agent_identity` gate on the edge, subscription payment, premium rate tier |

Everything here is fictional: the cooperative, the plant, the vendor, the
regulation, and every number.

## Run it

```sh
node examples/demos.js milky-way
```

Or drive it yourself. The audit agent, unprovisioned, in production context:

```sh
kcp-agent plan "prepare for the food safety authority audit at the Stjerneholmen plant" \
  --manifest examples/milky-way/hub --follow --as-of 2026-07-06 --env prod
```

The comms agent — R&D's `not_for` turns it away from the formulations in
the excluded topic's own words ("press releases"), and the brand press kit
catches it:

```sh
kcp-agent plan "draft the press release for the oat drink launch" \
  --manifest examples/milky-way/hub --follow --as-of 2026-07-06 --env prod
```

The R&D agent, fully provisioned — HSM attestation opens the restricted
formulations, the vendor credential opens the federation edge, and the
subscription moves it into the vendor's premium rate tier:

```sh
kcp-agent plan "cut the sugar in the oat drink formulation and update the ERP recipe integration" \
  --manifest examples/milky-way/hub --follow --as-of 2026-07-06 --env prod \
  --attest melkeveien-hsm --credentials sso_badge,vendor_portal_token --methods free,subscription
```

The same HR question, asked by an agent and by a human:

```sh
kcp-agent plan "how does the annual salary review work" --manifest examples/milky-way/people
kcp-agent plan "how does the annual salary review work" --manifest examples/milky-way/people --role human
```

The point: an enterprise documentation estate is not a wiki with better
intentions. When every domain declares what it publishes, for whom, from
when, and behind which gate, an agent can plan across the whole company —
and every document it did *not* load has a reason you could read to an
auditor.

The hub's manifest is signed; re-seal after editing:

```sh
node scripts/seal-example.mjs examples/milky-way/hub/knowledge.yaml milkyway-2026
```
