# Documentation policy

Every domain publishes a KCP manifest. The hub manifest is signed by the
Group Documentation Office; domains declare their own provenance.

- **Classification** travels in the manifest: `access` tiers, `audience`
  targeting, and `not_for` exclusions are machine-enforced, not tribal
  knowledge.
- **Versioning**: superseded documents declare their successor
  (`superseded_by`) instead of being deleted — the skip reason is the
  changelog.
- **Retirement**: validity windows (`valid_from` / `valid_until`) retire
  documents on schedule. Nothing goes stale silently.
