---
status: accepted
date: 2026-10-28
---

# Support Pi 1.x only

The maintainer has chosen Pi 1.x as the project's only supported Pi major version. Drop Pi 0.52 support and migrate to `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`. Maintaining two SDK contracts would add compatibility branches and test obligations while leaving the maintainer's actual Pi workspace on the newer contract.

## Alternatives considered

- Stay on 0.52. Rejected because it does not support the maintainer's Pi 1.x environment or address its normalized instruction and tool contracts.
- Support both 0.52 and 1.x. Rejected because the project does not need the ongoing adapter and dual-version testing burden.

## Consequences

- Do not preserve 0.52 behavior through compatibility adapters, legacy context fallbacks or a separate test matrix. Users of 0.52 must upgrade Pi to use future supported releases.
- Migration includes dependency metadata and imports, model catalog access, provider registration and thinking-level mapping. Effective instructions and tool declarations must come from the supported 1.x transcript APIs, not legacy top-level context fields or a frozen registry snapshot.
- Keep the CLI/relay architecture, Pi-owned tool execution, private CLI working directory and one-request guard. Changing the supported SDK does not authorize weakening these boundaries.
- Verify streaming, terminal failure and cancellation events, usage, supported observation hooks and provider-scoped environment handling. Document and warn about unsupported raw-request mutation rather than claiming native-provider parity.
- The migration must choose and document a minimum supported 1.x version and exact tested versions. CI must install reproducible SDK dependencies and run compatibility tests without relying on a global Pi installation. This decision does not promise compatibility with every 1.x release or Pi-derived host.
- Subscription billing-pool verification remains a separate human acceptance check. SDK compatibility does not establish how account usage is charged.

## Implementation status

This ADR accepts the support policy, not a completed implementation. At acceptance, the source and peer dependencies still target the 0.52 SDK. The minimum supported 1.x version and CI version matrix remain to be selected and verified during migration. Do not advertise the current release as verified Pi 1.x support on the strength of this ADR alone.

The decision resolves the version-family choice in [issue #39](https://github.com/markdlabrecque/pi-claude-subscription/issues/39). [The specification](../spec.md#supported-pi-versions) defines the migration requirements; [the README](../../README.md#pi-version-support) states the user-facing policy and migration status.
