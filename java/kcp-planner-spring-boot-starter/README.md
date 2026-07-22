# kcp-planner-spring-boot-starter

Spring Boot 3 auto-configuration for the [deterministic KCP planner](../kcp-planner).
Add the starter, point it at a `knowledge.yaml`, inject the planner — done.

```xml
<dependency>
  <groupId>no.cantara.kcp</groupId>
  <artifactId>kcp-planner-spring-boot-starter</artifactId>
  <version>0.16.0</version>
</dependency>
```

## Configure

```yaml
kcp:
  planner:
    manifest-path: classpath:knowledge.yaml            # local file or classpath resource
    # manifest-url: https://example.com/knowledge.yaml # remote (overrides path; SSRF-guarded)
    default-role: agent
    default-env: prod
    max-units: 5
    strict: false
    verify: false                                      # verify the manifest signature on load
    refresh-interval: PT5M                             # re-fetch a remote manifest periodically
    ssrf-guard:
      enabled: true                                    # refuse private/loopback hosts (default)
      allow-http: false                                # permit cleartext http:// + private hosts
```

## Inject

The auto-configuration exposes three beans: the loaded `Manifest`, a `ManifestSource`
(the refreshable holder), and `KcpPlannerService` — the injectable planning facade.

```java
@Service
public class KnowledgeService {
    private final KcpPlannerService planner;

    public KnowledgeService(KcpPlannerService planner) {
        this.planner = planner;
    }

    public AgentPlan planFor(String task) {
        return planner.plan(task);                 // uses the configured manifest + defaults
    }

    public DecisionTrace traceFor(String task) {
        return planner.trace(task);
    }
}
```

`KcpPlanner` itself is a stateless static utility (`KcpPlanner.plan(manifest, task)`);
`KcpPlannerService` binds it to the configured manifest and `default-*` options so a bean
can plan in one call. In a non-Boot Spring app, add `@EnableKcpPlanner` to import the same
beans.

## Health

With Spring Boot Actuator on the classpath, `/actuator/health` includes a `kcpPlanner`
indicator:

```json
{
  "status": "UP",
  "details": {
    "project": "my-service",
    "version": "1.2.0",
    "kcpVersion": "0.25",
    "unitCount": 24,
    "source": "classpath:knowledge.yaml",
    "lastRefresh": "2026-07-07T10:00:00Z"
  }
}
```

The indicator only wires up when Actuator is present — the starter works without it.

## Other JVM frameworks

The core `no.cantara.kcp:kcp-planner` artifact has **zero** Spring dependency and runs
in Quarkus, Micronaut, or plain Java. This starter is the Spring-Boot convenience layer;
elsewhere, depend on `kcp-planner` directly and call `KcpPlanner.plan(manifest, task)`.
