# Changelog

## v1.6.0

Changes since the last published GitHub release, [v0.4.0](https://github.com/markdlabrecque/pi-claude-subscription/releases/tag/v0.4.0). The v1.5.0 tag exists, but its release workflow failed before publication. Compared with that tag, v1.6.0 fixes CI and updates release metadata and documentation; it adds no further runtime changes.

### Added

- Opt-in local audit logging for request outcomes, usage and API-equivalent cost estimates, with correlated request records, private files, retention and size limits. Audit logging stays off by default and excludes prompts, tool content and credentials.
- Standalone extension-loader audit checks and isolated packaged-source loading tests.
- Live-acceptance tooling with cache-prefix assertions, request and token budgets, and diagnostics. Live checks require explicit approval; offline tests do not certify account billing or arbitrary host compatibility.

### Fixed

- Extension loading through Pi 1.4.0 for packaged and Git/local installations.
- Dropped upstream response streams are reported promptly while preserving observed usage and the one-request-per-turn limit.
- Temporary-directory cleanup failures no longer crash Pi. Cleanup uses bounded retries and nonfatal warnings.
- Cache-prefix normalization handles the CLI's newer environment-block format and reports whether normalization succeeded.
- Audit logging handles directory replacement during lock contention, captures API HTTP failure metadata and observes usage before stream hooks can throw.
- Release tests validate the current extension version independently of the pinned Pi SDK version, rather than failing on every extension version bump. Research HTML now passes the CI formatting check.

### Distribution and compatibility

- Releases are GitHub source releases only, with no npm publication or registry credentials.
- Requires Node.js 22.19.0 or later and Pi 1.x. The tested Pi SDK pair remains pinned to 1.4.0; the extension version is independent of the SDK version.
- No personal Pi installation, CLI login or API-key fallback setting is changed by this release.

### Install

```bash
pi install git:github.com/markdlabrecque/pi-claude-subscription@v1.6.0
```

Pinned tags do not advance through `pi update --extensions`. Review the [requirements and known limits](README.md) before upgrading. For audit-only issues, unset `PI_CLAUDE_SUBSCRIPTION_AUDIT` or set it to `0` and restart Pi. The older v0.4.0 release has a known Pi 1.4.0 loader defect and is not a verified rollback target on that host.
