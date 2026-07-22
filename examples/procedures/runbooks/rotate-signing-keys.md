# Rotate signing keys

Emergency runbook for rotating the production signing keys after a suspected
compromise. Generates a new keypair, publishes the new public key, and revokes
the old one after a grace window.

This is a `kind: skill` unit with no `load_eligible` grant — planning it is
always safe (audit before action), but nothing may invoke it until an
operator explicitly grants eligibility for this task.
