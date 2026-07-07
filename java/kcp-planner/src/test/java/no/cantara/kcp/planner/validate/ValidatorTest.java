package no.cantara.kcp.planner.validate;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.stream.Collectors;

import no.cantara.kcp.planner.ManifestParser;
import no.cantara.kcp.planner.model.Manifest;

import org.junit.jupiter.api.Test;

/**
 * Exercises the manifest linter against a manifest crafted to trip a representative
 * set of rules, asserting the exact reference finding messages (no {@code baseDir},
 * so path-existence checks are skipped and the result is deterministic).
 */
class ValidatorTest {

    private static final String MANIFEST = """
            project: t
            version: 1.0.0
            units:
              - id: a
                path: docs/a.md
                intent: "deploy guide"
                triggers: [deploy]
                audience: [agent]
                not_for: ["questions about deploy tooling"]
              - id: a
                path: /etc/passwd
                intent: ""
                audience: [agent]
                triggers: [x]
              - id: c
                path: docs/c.md
                intent: "c doc"
                audience: [agent]
                triggers: [y]
                access: weird
                temporal: { valid_from: "2026-01-02", valid_until: "2026-01-01" }
            manifests:
              - id: r
                url: http://x.example.com/k.yaml
                agent_identity: { required: true }
            """;

    @Test
    void findingsMatchTheReference() {
        Manifest m = ManifestParser.parse(MANIFEST, "test");
        List<Finding> findings = Validator.validateManifest(m, null);
        List<String> messages = findings.stream().map(Finding::message).collect(Collectors.toList());

        assertTrue(messages.contains("missing 'kcp_version' — agents cannot tell which spec revision this targets"));
        assertTrue(messages.contains("duplicate unit id"));
        assertTrue(messages.contains("path must be relative, not absolute"));
        assertTrue(messages.contains("missing 'intent' — intent is the primary navigation signal"));
        assertTrue(messages.contains("temporal window ends (2026-01-01) before it starts (2026-01-02)"));
        assertTrue(messages.contains("unknown access 'weird' (expected public/authenticated/restricted)"));
        assertTrue(messages.stream().anyMatch(s -> s.startsWith("not_for 'questions about deploy tooling' contains the unit's own vocabulary (deploy)")));
        assertTrue(messages.contains("url is not https — agents should fetch federation over TLS"));
        assertTrue(messages.contains("agent_identity.required without 'credential_hint' — agents cannot plan credential acquisition"));

        // There is at least one error → the manifest does not validate clean.
        assertFalse(findings.stream().noneMatch(f -> f.level().equals("error")));
    }

    @Test
    void requireAttestationWithoutProvidersIsAPermanentFailClosed() {
        Manifest m = ManifestParser.parse("""
                kcp_version: "0.25"
                project: t
                version: 1.0.0
                trust:
                  agent_requirements:
                    require_attestation: true
                units:
                  - id: a
                    path: a.md
                    intent: "x"
                    audience: [agent]
                    triggers: [a]
                """, "test");
        List<Finding> findings = Validator.validateManifest(m, null);
        assertTrue(findings.stream().anyMatch(f -> f.level().equals("error")
                && f.message().contains("permanently fail-closed")));
    }
}
