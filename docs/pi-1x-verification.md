# Pi 1.x migration verification

## Verified versions

- Minimum Pi release: 1.4.0.
- Exact development/test SDKs: `@earendil-works/pi-ai@1.4.0` and `@earendil-works/pi-coding-agent@1.4.0`.
- Local platform: Linux. Node 22.19.0 and 24.20.0.
- CI configuration: Node 22.19.0, Linux/macOS/Windows, the same locked SDK pair. Remote results are pending execution, not part of the local evidence. Source review identified a native-Windows process-tree cleanup limitation: runtime group killing is POSIX-only, and killing a Windows `.cmd` launcher does not reap its descendants. The matrix and cleanup assertions remain intact. Native Windows is unsupported; use WSL. This is separate from SDK compatibility, and this change does not claim that the Windows job passes.
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

## Packed-tarball load (#38)

- Tested Pi version: 1.4.0 (`@earendil-works/pi-coding-agent@1.4.0`).
- Result: FAILS. Loading the extension from the packed tarball with `discoverAndLoadExtensions` errors with `Cannot find module '.../pi-ai/dist/compat.js/providers/anthropic'`. Pi 1.4.0's extension loader does not resolve the `@earendil-works/pi-ai/providers/anthropic` and `@earendil-works/pi-ai/api/anthropic-messages` imports.
- The #38 acceptance item "loads in pi from a packed tarball" is not met. It waits on a follow-up fix to the pi-ai import paths.
- `tests/packed-tarball-load.test.ts` holds the check and is skipped until that fix lands.

## Third-party tools and attachments (#52)

- SDKs: `@earendil-works/pi-ai@1.4.0`, `@earendil-works/pi-coding-agent@1.4.0` and the `@earendil-works/pi-tui` copy they install. Fake CLI and fake upstream only; synthetic data only.
- Fixture: `tests/fixtures/pi-manage-todo-list/`, tintinweb/pi-manage-todo-list at `2eb22d3b0c9dd981398d928c8edcc4afce202fa1`, manifest 0.4.0, MIT. `PROVENANCE.json` records each file's source URL and sha256. The fixture is excluded from lint and formatting so it stays byte-for-byte, and it is still typechecked with the project.
- `tests/extension-compat.test.ts` checks the provenance record and runs the fixture's `manage_todo_list` read through `createAgentSession`, Pi's tool loop and the registered provider. It also runs a small #50 scoped-environment and #51 `onPayload` check.
- `tests/attachments.test.ts` covers pass-through and typed rejection in replay, resume and resume-to-replay fallback.
- Commands: `npm ci`, then the commands under [Reproduce](#reproduce). The new tests run in the existing `npm test` and `npm run test:coverage` jobs; CI configuration is unchanged.
- Local result for this change: `npm test` only. Lint, format, typecheck-only and coverage runs, and remote CI results, are not part of this record.

## Boundaries

Instruction forwarding #40, tool inventory/activation #42, workspace guidance #43, terminal failures #41 and broader extension compatibility #14 remain separate. The #50/#51 checks in #52 consume their behaviour and do not repeat their test matrices. Pricing #34 and human billing verification #35 are unchanged. Cache optimization waits for #39, #40 and #42.
