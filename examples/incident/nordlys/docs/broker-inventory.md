# Quaymaster Broker inventory — Nordlys Energi

*(Fictional example content.)*

| System | Version | Exposure | Owner |
|---|---|---|---|
| grid-events-prod | 4.7.9 | internal + partner VPN | Team Fossekall |
| meter-ingest-prod | 4.7.9 | internal only | Team Fossekall |
| trading-bus-prod | 4.6.2 | internal + market gateway | Team Rein |
| lab-broker-dev | 4.8.0-rc1 | lab network | Team Fossekall |

All production brokers run with the management listener enabled on the
default port. `trading-bus-prod` is two minor versions behind the fleet.
