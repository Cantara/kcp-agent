# The 03:00 Page — a federated incident-response world

A zero-day in **Quaymaster Broker** (fictional message-broker software) is
being actively exploited. The pager goes off at 03:00 at **Nordlys Energi**
(fictional Norwegian energy company). This directory is the knowledge
landscape that night, as four independent parties publish it:

| Party | Directory | Role | What it exercises |
|---|---|---|---|
| Nordlys Energi | `nordlys/` | Internal hub, the agent's entry point | Attestation-gated restricted runbook, federation refs |
| FjellCERT | `fjellcert/` | National CERT | ed25519-signed manifest, advisory supersession (§4.22) |
| Quaymaster Systems | `quaymaster/` | The vendor | Free security bulletin, `not_for` negative space |
| Ravnwatch | `ravnwatch/` | Commercial threat intel | TLP:AMBER as a *gate* (attestation + credential + x402), budget |

Everything here is fictional: companies, advisories, indicators
(TEST-NET addresses, dummy hashes), and the CVE-style identifiers.

## Run it

```sh
node examples/demos.js incident
```

Or drive it yourself — first the unprovisioned 03:00 agent:

```sh
kcp-agent plan "quaymaster broker zero-day active exploitation - what do we do right now?" \
  --manifest examples/incident/nordlys --follow --as-of 2026-07-08
```

Then the provisioned responder:

```sh
kcp-agent plan "quaymaster broker zero-day active exploitation - what do we do right now?" \
  --manifest examples/incident/nordlys --follow --as-of 2026-07-09 \
  --attest soc.nordlys.example --credentials mtls \
  --methods free,x402 --budget 0.50
```

The point: the unprovisioned agent still gets a plan — with every closed gate
carrying a written reason (attestation it cannot present, credentials it does
not hold, intel it cannot pay for). The provisioned responder gets the
runbook, the advisory that superseded the 03:00 workaround, and a committed
intel spend — all decided deterministically, before a single byte is loaded.

FjellCERT's manifest is signed; re-seal after editing it:

```sh
node scripts/seal-example.mjs examples/incident/fjellcert/knowledge.yaml fjellcert-2026
```
