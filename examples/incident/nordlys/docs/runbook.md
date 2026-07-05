# Sev-1 runbook — active exploitation

*(Fictional example content. `access: restricted` + `read:incident` — this
file only reaches an agent that presented attestation and a credential.)*

1. **Isolate**: pull affected brokers from the partner VPN and market
   gateway segments. Grid-critical flows fail over to the standby bus.
2. **Contain**: disable the management listener fleet-wide via config
   push `qm-mgmt-off`; capture memory and listener logs first.
3. **Escalate**: page the security duty officer; open a Sev-1 bridge;
   notify FjellCERT within 2 hours (regulated-sector obligation).
4. **Communicate**: status page holds until the duty officer approves;
   partner notifications go through the comms lead only.
