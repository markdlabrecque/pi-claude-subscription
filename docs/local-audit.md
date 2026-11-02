# Local audit logging

Audit logging and its review fixes are merged into the source prepared for extension v1.4.0 stable, along with the Pi SDK 1.4.0 loader fix. The released v0.4.0 tag has neither audit logging nor the loader fix. Prepared source is not a published release or a personal installation update. See the [v1.4.0 release checklist and rollback instructions](releases/v1.4.0.md). Confirm the installed extension loads before relying on request logging.

## Enable for the week's work

Set these in the environment that starts Pi:

```bash
export PI_CLAUDE_SUBSCRIPTION_AUDIT=1
export PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK=0
export PI_CLAUDE_SUBSCRIPTION_SESSION_MODE=replay
unset PI_CLAUDE_SUBSCRIPTION_DEBUG
pi
```

`true` also enables auditing. Unset the audit flag or set it to `0` to stop recording. The mode is off by default and creates no audit files while off. Audit does not enable verbose debug logging, and debug does not enable audit. Keep raw debug off unless diagnosing a specific problem.

The default files are:

```text
<installed-extension-root>/.audit/YYYY-MM-DD.jsonl
```

Dates and timestamps use UTC. The root is the extension's directory, not the Pi workspace or the private Claude CLI cwd. `PI_CLAUDE_SUBSCRIPTION_AUDIT_DIR` can select another directory within the same extension installation, relative to that root or absolute. Outside paths and symlinked directory components are rejected. Request-scoped `env` can override the audit flag and directory, so ensure orchestration requests use the intended settings too. Startup records use Pi's process environment.

There is no automatic fallback to a home or system log directory. A read-only installation, invalid path or write failure prints a content-free `audit ... unavailable` warning and leaves the provider outcome unchanged. If that warning appears, the ledger is incomplete. It is not enough that the model request succeeded.

## Recorded data

Each JSONL line has `schemaVersion: 1` and a UTC `timestamp`. Event types are `registration`, `extension_load`, `request_start` and `request_terminal`.

- Requests have a generated `requestId`, model, route `cli` or `api`, configured replay/resume mode and observed extension/Pi/CLI versions. Unavailable versions are null. CLI version uses the last startup observation; no extra credential or account probe runs for audit records.
- Starts precede tool-inventory and provider preflight checks. Terminal records cover successful text/tool/length stops, cancellation, unsupported attachments, repeated failing tools, inventory setup, CLI spawn/exit, empty/incomplete output, result errors, hook errors, auth/rate/server failures and timeouts. Errors use bounded categories rather than raw exception text.
- CLI records include observed upstream/rejected counts, safe failure HTTP status and numeric retry-after when available. A resume-to-replay fallback has one request ID and terminal record with distinguishable attempts. API failure status and numeric retry-after are observed through a request-local fetch wrapper because the SDK does not deliver failed responses to `onResponse`. The wrapper preserves the caller's transport, response body and hook behavior. A new attempt clears previous failure metadata, so recovered failures are not attributed to a later hook or network error.
- `usage` includes reported input, output, cache-read, cache-write and 1-hour cache-write tokens. Fields not observed are null, including API failures before a response. Later reported usage corrects earlier counts rather than adding them again. Both routes record received usage before invoking stream-event hooks, so a throwing hook does not erase the counts already observed.
- `estimatedCost` contains API-equivalent estimates for known buckets, not subscription charges or quota usage. When a bucket is unknown its estimate is null; the total is null unless all component estimates are known. An unknown cache tier uses the model's ordinary cache-write estimate, consistent with existing provider estimation; it does not prove a 5-minute cache tier.
- `cleanup` distinguishes attempted cleanup from observed process close and successful resource removal. `confirmed` for the process means its close event was observed, not that every possible descendant was independently checked. API cleanup remains unknown because this extension does not own its transport.

The sink never persists prompts, generated text/thinking, tool arguments/results, attachments, request headers, credentials, account identifiers, raw stderr, raw hook errors or workspace paths. It writes allowlisted metadata only. Raw debug output has a different privacy contract and is not copied into this ledger.

## Audit loading separately

Extension code cannot log a failure that prevents that code from importing. An explicit standalone check uses the installed Pi SDK loader and records a sanitized `extension_load` outcome in the same audit directory:

```bash
PI_CLAUDE_SUBSCRIPTION_AUDIT=1 \
  node <installed-extension-root>/src/audit-loader-check.mjs
```

Replace the placeholder with the actual extension directory. The check uses an isolated temporary workspace and agent directory and loads only this extension. It does not call a model or provider stream. If the extension reaches registration, its normal CLI presence/authentication validation can run. This is an explicit loader check, not an automatic capture of every future Pi startup failure.

An unavailable SDK import, thrown loader error or reported loader error is recorded as failure. No loaded/registered provider is recorded as skipped. Both yield exit status 1. Success requires the loader to report the extension and the expected provider registration. With audit off, the command does nothing and exits 0; that is not evidence of a successful load. The merged #76 fix resolves the packaged-load import defect against SDK 1.4.0. The v0.4.0 tag still lacks that fix. See [loading verification](pi-1x-verification.md#packed-tarball-load-38) for the tested installation paths and limitations.

## Reading the week

Pair `request_start` and `request_terminal` by request ID. A terminal record means an observed invocation, not an entire human prompt or agent task. Tool loops and Pi retries create additional invocations. API routing should not appear if explicit fallback remains off and this is the only provider selected.

Look for:

- `outcome: error` or `cancelled`, especially `http_error`, `timeout`, `protocol_error` and hook failures;
- `reason: length` for completed but output-limited responses;
- increasing cache writes and reduced reads after instruction, tool-loadout or CLI changes;
- unexpected `route: api`, rejected relay requests, failed/unknown cleanup and audit-unavailable warnings;
- starts with no matching terminal record. They are incomplete, not successful or free. A hard kill may prevent the final record even if upstream generated tokens.

Logs cannot identify the Team billing pool, prove every extension works, or reveal the precise cause of a network cut-off when only a timeout was observed. The stream-cutoff responsiveness issue remains separate. Keep account spending controls enabled and API fallback off if separately billed API use is unwanted.

## Retention and failure limits

Directories are mode 0700 and files 0600 on supported POSIX platforms. Appends use an inter-process lock, size checks and fsync; concurrent records are serialized. Open directory descriptors retain the verified root/component identities across lock waits. Replaced directories are rejected before retrying the lock, retention, append and lock removal. The retention/append section has no asynchronous waits or caller callbacks after revalidation. These checks cover replacement during lock contention, not hostile cross-process replacement between filesystem syscalls. Node's portable filesystem API does not provide atomic descriptor-relative operations, so the installation directory must not be writable by an untrusted process. Daily files stop accepting records at 5 MiB and warn rather than growing without bound. Writes remove daily files older than the current UTC day and six preceding days. Archive needed files privately before they expire.

A hard kill during an append can leave `<audit-directory>/.append-lock`. Later writes time out and warn; they do not steal a potentially live lock. If it remains, stop all Pi sessions and loader checks using that directory before removing the empty stale lock directory. A partial final line after a hard kill is also possible. Neither case justifies inventing a terminal record.

Default audit data is Git-ignored. JSONL files and lock directories are excluded from packaged `src/` contents too, including an explicitly configured audit directory under `src/`. Do not rename logs into other tracked/runtime files. The sink is not an encrypted storage system.

## Verification evidence

The historical implementation verification had 76 focused synthetic tests, including filesystem privacy, off-mode behavior, retention/size limits, concurrent appends, write failures, early errors, successful/partial usage, cancellation races, both provider routes and standalone SDK loader delegation.

The initial candidate was committed as `43c87b0`. Subsequent adversarial review found three defects despite its green tests. Regression tests reproduced outside-directory writes/deletion during lock contention, missing real-SDK API HTTP failure metadata and usage lost when a CLI stream hook throws. Those tests failed against the initial implementation and pass with the fixes. Added checks also cover root/ancestor swaps, replacement locks, recovered HTTP retries and later usage corrections.

Historical local Linux checks on the audit review candidate passed:

- 587 tests, with the pre-existing packed-loader test still skipped;
- coverage of 97.36% statements/lines, 91.55% branches and 98.63% functions;
- typecheck and style checks;
- standalone code review found no concrete code findings in the defect fixes. This is not merge approval or installed-host certification.

The configured coverage percentage covers TypeScript source, not the CJS sink or the standalone subprocess. Behavioral tests execute both separately. No live model, billing-account check or actual-host load certification was performed. The source release's green CI is historical evidence, not remote CI for these uncommitted changes. `npm ci` reported 35 dependency audit findings, including four critical; no unrelated dependency upgrades were applied.

A local `.audit/verification.json` manifest may describe an earlier candidate. Check its source fingerprints before using it as evidence for the current revision. It is verification metadata, not a runtime usage record or a new billing claim. The loader check records fresh loader evidence in the daily ledger when explicitly run; the human-readable historical release evidence remains linked in [the roadmap](roadmap.md).
