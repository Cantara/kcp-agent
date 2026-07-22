# Restart web service

Restarts the web service after a bad deploy. Scoped to a single systemd unit
under `/opt/web-service`; carries an explicit `action_scope` grant, so it is
load-eligible for any task that matches it.
