# Integration catalog (live)

| Interface | From → To | Owner | Environments |
|---|---|---|---|
| order-intake | Orion ERP → plant MES | Integration Platform | prod, staging |
| batch-report | plant MES → Orion ERP | Integration Platform | prod, staging |
| dispatch-plan | Orion ERP → logistics TMS | Logistics IT | prod |
| quality-release | LIMS → Orion ERP | Quality IT | prod, staging |
| dairy-forecast | forecast service → Orion ERP | Data team | prod |

Owners are accountable for contract changes. New interfaces register here
before first deploy — the catalog is the source of truth the agents read,
so an unregistered integration does not exist.
