# Pi 1.x migration verification

## Current release status

As of 2026-11-01, v0.4.0 is released on GitHub at commit `8f8b45b`. [Main CI run 41323671647](https://github.com/markdlabrecque/pi-claude-subscription/actions/runs/41323671647) passed Linux/macOS tests, lint and typecheck. That release left the packed-tarball loader test skipped and its acceptance item unmet. The branch fix for #76 now passes packed-install and Git/local checkout loading against SDK 1.4.0, as recorded below. It is not part of the v0.4.0 tag.

All 45 GitHub issues are closed. Some sections below record earlier implementation runs, not current pending tickets or fresh acceptance of the whole release. See [the reconciled roadmap](roadmap.md) and [first tool-result cache verification](first-tool-result-cache-verification.md) for later evidence. No new live request or account billing check was made for this documentation reconciliation.

## Verified versions

- Minimum Pi release: 1.4.0.
- Exact development/test SDKs: `@earendil-works/pi-ai@1.4.0` and `@earendil-works/pi-coding-agent@1.4.0`.
- Local platform: Linux. Node 22.19.0 and 24.20.0.
- CI configuration: Node 22.19.0, Linux/macOS, the same locked SDK pair. Native Windows is unsupported and excluded from CI by maintainer decision; use WSL. Runtime process-group cleanup is POSIX-only, and killing a Windows `.cmd` launcher does not reap its descendants. Linux/macOS cleanup assertions remain intact. See the CI execution evidence below.
- CLI contract inspection: Claude Code 2.1.312 `--help` lists `--effort low|medium|high|xhigh|max`. Automated execution uses the fake CLI, not a subscription or live model. This does not verify reasoning quality or all real CLI releases.

## Reproduce

```bash
npm ci
npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent --depth=0
npm run test:coverage
npm run lint
npm run typecheck
npm run format:check
```

No global Pi, real Claude CLI, subscription login or API secret is required. Tests import installed SDK modules normally; a missing SDK fails installation or import instead of skipping. Developer nested worktrees are excluded from test/lint discovery. Generated HTML plans with bundled vendor code are excluded from formatting; no test or coverage assertion was removed.

Local results: 26 test files, 360 tests passed. Coverage exceeds the existing 92% statements/lines/functions and 88% branch thresholds. Lint, full-project typecheck including acceptance scripts, and formatting passed. No paid acceptance request was made. `npm ci` reports 18 dependency audit findings; this migration does not apply unrelated dependency upgrades.

## Executed contracts

1. `tests/registered-provider.test.ts` loads the extension factory and streams real normalized text through its registered callback, fake CLI, relay and upstream. It checks final model/provider/API metadata, streamed text, measured usage and one upstream request.
2. `tests/sdk-startup.test.ts` uses isolated agent/auth/catalog directories, `createAgentSessionServices`, `ModelRuntime`, `DefaultResourceLoader`, in-memory settings/session and `createAgentSession`. The registered subscription model is available before settings-driven startup selection, without an API key or model-catalog network request, and completes a request.
3. `tests/catalog-thinking.test.ts` checks the four latest catalog families, one catalog-backed Fable, input/image limits, context/output limits and costs after real SDK registration. It exercises every advertised thinking level through the CLI and checks the actual outgoing arguments, SDK support/clamping, explicit max and deliberate effort omission. Unknown model names cannot acquire max through an Opus substring.
4. `tests/api-key-sdk.test.ts` switches the same registered callback to the real SDK Anthropic API using synthetic keys and an injected SSE transport, verifies supported option forwarding and cancellation, then switches back to CLI. No real API endpoint is contacted.
5. `tests/registered-tools.test.ts` drives a normalized stable-inventory custom tool call/result round-trip through the registered callback. Pi/test-side execution produces the result used in the final streamed text. It checks schema-only MCP, exact names/arguments, synthetic host marker exclusion, fresh private cwd/config/schema cleanup, process cleanup and closed relay ports. Process-tree cleanup has been executed locally on Linux only; native Windows has the limitation noted above. A fake CLI attempts an extra generation on each request; only one reaches upstream.
6. `tests/pi-real-shape.test.ts` now uses the registered callback and local SDK for the existing normalized name-resolution/unknown-name/bounded-repeat regressions. Existing break-early, isolation, error/cancel cleanup and relay guard regressions remain intact.

## CI execution gate (#46)

The previous workflow targeted only `main`, so pushes and pull requests targeting `develop` did not run CI. The workflow now targets both branches and also supports `workflow_dispatch`. CI covers the supported Linux/macOS platforms. Node 22.19.0, installed-SDK checks, coverage thresholds and cleanup assertions are unchanged.

Local re-verification of the CI-trigger change on Linux used Node 22.19.0 and the locked Pi SDK pair at 1.4.0. `npm run test:coverage` passed 498 tests in 43 files, with the separate #38 packed-tarball test still skipped. Coverage was 98.19% statements/lines, 91.79% branches and 99.2% functions. `npm run typecheck` and `npm run check-style` passed. YAML parsing and explicit trigger, matrix and runtime assertions also passed. Only fake CLI/upstream requests were used.

[CI run 41283185003](https://github.com/markdlabrecque/pi-claude-subscription/actions/runs/41283185003) on commit `b183e03` passed lint, typecheck and the Linux/macOS test jobs; the Windows test job failed. The maintainer then explicitly dropped native Windows support and its CI job. This supersedes #46's earlier three-platform acceptance requirement; Windows is not treated as passing or repaired. Linux/macOS tests and assertions are unchanged. The supported-platform follow-up passed; #46 is now closed. The v0.4.0 main CI run linked above also passed on Linux/macOS.

## Packed-tarball load (#38)

The #76 fix was verified locally on Linux with Node 24.20.0 and the exact installed pair `@earendil-works/pi-coding-agent@1.4.0` and `@earendil-works/pi-ai@1.4.0`.

Before changing implementation, enabling the skipped test freshly reproduced `Cannot find module '.../pi-ai/dist/compat.js/providers/anthropic'`. Pi 1.4.0's Jiti loader aliases the SDK root to `compat.js`, so unrecognized subpaths append to that filename. This affected catalog/thinking imports as well as the eager fallback imports, regardless of the fallback flag.

The fix reads the catalog from the loader-supported `@earendil-works/pi-ai/providers/all` entrypoint and obtains `anthropicMessagesApi` from the explicit `@earendil-works/pi-ai/compat` entrypoint. That factory lazily loads the Anthropic implementation on a fallback request. It does not use the legacy global registry or add Pi 0.x support.

Reproduce from the fixed checkout with a fresh npm cache:

```bash
export npm_config_cache="$(mktemp -d)"
npm ci
npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent --depth=0
npx vitest run tests/packed-tarball-load.test.ts
npx vitest run tests/api-key-sdk.test.ts tests/registered-provider.test.ts tests/catalog-thinking.test.ts
npm run test:coverage
npm run typecheck
npm run check-style
```

`tests/packed-tarball-load.test.ts` runs without skips. It independently checks:

- A tarball created by `npm pack --json --ignore-scripts --pack-destination <temp>`, installed with `npm ci --offline --ignore-scripts --legacy-peer-deps --no-audit --no-fund` in a temporary fixture. The fixture's manifest points to the actual tarball. Its generated lockfile copies runtime dependency versions, resolved URLs and integrity hashes from the repository lockfile. The initial `npm ci` caches those exact dependency tarballs; cached registry metadata is not required. Host SDK peers are supplied by Pi, not copied or linked into the package.
- The Git/local source checkout after `npm ci`, loaded by its package directory and manifest, not a tarball or mocked factory.

Each source loads in a fresh Node subprocess through the real installed `discoverAndLoadExtensions`, using isolated workspace and agent directories. Each is tested with API fallback both disabled and enabled. Assertions require no loader errors, the expected extension entry, a registered provider with models and a streaming callback, and the shipped MCP server. A fake Claude CLI handles startup presence/auth probes. Loading checks invoke no provider stream or model request.

The separate registered-provider and API-key SDK regressions use fake CLI/upstream traffic and an injected synthetic SSE transport to verify CLI text, API fallback option forwarding, cancellation and switching back to CLI. No live model or account request was authorized or sent.

The original range-resolving offline install was also tested after `npm ci` with a fresh cache. It failed with `ENOTCACHED` for `cross-spawn`, despite the locked tarballs being present. The lock-backed fixture passes with that same metadata-cold cache.

Local result: 591 tests across 53 files, with no skips. Coverage thresholds, typecheck and style pass. The existing CI matrix runs these checks on Linux/macOS with Node 22.19.0; remote CI for this branch has not yet run.

Limitations: this establishes installed SDK loading, not npm publication, remote Git fetching, compiled/bundled Pi binaries, personal Pi configuration, arbitrary Pi-derived hosts or every later SDK. The fix is not in the v0.4.0 release. A Git-installed checkout must contain this fix; changing distribution channels alone does not repair old source.

## Third-party tools and attachments (#52)

- SDKs: `@earendil-works/pi-ai@1.4.0`, `@earendil-works/pi-coding-agent@1.4.0` and the `@earendil-works/pi-tui@1.4.0` copy they install (locked in `package-lock.json`; the fixture resolves the hoisted copy). Vitest 3.2.4. Fake CLI and fake upstream only; synthetic data only.
- Fixture: `tests/fixtures/pi-manage-todo-list/`, tintinweb/pi-manage-todo-list at `2eb22d3b0c9dd981398d928c8edcc4afce202fa1`, manifest 0.4.0, MIT. `PROVENANCE.json` records each file's source URL and sha256. The fixture is excluded from lint and formatting so it stays byte-for-byte, and it is still typechecked with the project.
- `tests/extension-compat.test.ts` checks the provenance record and runs the fixture's `manage_todo_list` read through `createAgentSession`, Pi's tool loop and the registered provider. It also runs a small #50 scoped-environment and #51 `onPayload` check.
- `tests/attachments.test.ts` covers pass-through and typed rejection in replay, resume and resume-to-replay fallback. `tests/attachments-resume.test.ts` covers resume's tool-result path: the request carries the new tool result and does not resend an earlier image the resumed session already holds.
- Commands: `npm ci`, then the commands under [Reproduce](#reproduce). The new tests run in the existing `npm test` and `npm run test:coverage` jobs; CI configuration is unchanged.
- Local results for this change, Linux, run by a person on HEAD `6fc4aaf` on 2026-10-30:
  - `npm test`: passed twice, 37 test files, 432/432 tests. This includes the focused `tests/extension-compat.test.ts`, `tests/attachments.test.ts`, `tests/attachments-resume.test.ts` and `tests/prompt-builder.test.ts`.
  - `npm run typecheck` (`tsc --noEmit`, full project including `tests/fixtures/pi-manage-todo-list/`): passed, exit 0.
  - `npm run lint`: passed, exit 0.
  - `npm run format:check`: passed, exit 0; all matched files use Prettier code style.
  - `npm run test:coverage`: run 3 times. Runs 2 and 3 passed 432/432 tests with coverage for all files at 98.18% statements, 91.5% branches, 99.16% functions and 98.18% lines, above the existing thresholds.
  - Intermittent failure: coverage run 1 failed 3 of 432 tests in `tests/sdk-startup.test.ts`, `tests/pi-instructions.test.ts` and `tests/provider-hooks.test.ts`. In each, the fake upstream saw 2 requests instead of 1, or an extra `GET /`. It did not recur in the later runs and was not fixed by this change. This is an unresolved observation from that run, not a currently open GitHub issue.
  - Remote CI: not run.

## Boundaries

Instruction forwarding #40, tool inventory/activation #42, workspace guidance #43, terminal failures #41, documented extension compatibility #14, scoped environment #50 and hooks #51 are implemented and closed. Their individual tests still define the extent of coverage; #52 does not certify arbitrary extensions or native-provider parity.

Pricing/accounting #34 and cache-prefix fixes #32/#33 are also implemented. #35 was closed because the maintainer disabled extra spending, without a recorded account-side billing-pool measurement. Remaining loader, dropped-stream and acceptance-evidence gaps are listed in the roadmap rather than presented as open issues.
