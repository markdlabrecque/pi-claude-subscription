# Cache prefix verification

Investigation for [issue #32](https://github.com/markdlabrecque/pi-claude-subscription/issues/32), run on Linux on 2026-11-01. Both installed Pi packages were exactly 1.4.0, Node was 24.20.0, the extension manifest was 0.3.1, and the official Claude CLI was 2.1.316. Baseline source was `a801358` on `develop`; the fixed measurements include the working-tree changes for this issue. Model: `claude-haiku-4-5`.

## Reproduction

The provider received normalized Pi 1.x transcript context, used stateless replay and launched the real CLI. An initial local SSE endpoint returned synthetic text completions, allowing consecutive request bodies to be compared without subscription traffic. The previous request's message content was not an identical prefix of the next request. The first difference was the CLI-generated environment reminder's private temporary cwd. System prompt and tool declarations were identical. Ignoring just that cwd and cache-control placement left the previous message content intact.

A live three-turn baseline with about 10.5K tokens of repeated reference text confirmed a cache failure. Each turn reported `input: 10`:

- Turn 1: `cacheRead: 0`, `cacheWrite: 10537`.
- Turn 2: `cacheRead: 0`, `cacheWrite: 10557`.
- Turn 3: `cacheRead: 0`, `cacheWrite: 10581`.

The historical fixed shortfall of about 337 tokens was not reproduced on these versions. The current cwd defect invalidated the entire message prefix instead. Historical observations are not evidence that assistant signatures or a trailing replay instruction still need changing.

## Fix and result

Normalize only the private cwd value in the CLI-generated environment reminder before forwarding the request and before the caller's `onPayload` hook. Do not reuse a working directory or remove instructions. The actual subprocess isolation, Pi's complete current instructions, workspace guidance, history and tool inventory remain unchanged.

The first live run after the fix reported `input: 10` on every turn:

- Turn 1: `cacheRead: 0`, `cacheWrite: 10533`.
- Turn 2: `cacheRead: 10533`, `cacheWrite: 22`.
- Turn 3: `cacheRead: 10555`, `cacheWrite: 22`.

Thus both follow-ups read the full previous cached prefix. A subsequent run reused the cache, reading 10533, 10555 and 10577 tokens with zero writes. Every turn forwarded exactly one request and received HTTP 200. Neither headers nor request bodies were written to disk or logs.

## Second reminder shape (issue #86)

A live capture on 2026-11-02 showed the raw private cwd reaching Anthropic again. That run used Claude CLI 2.1.316 on Linux and `claude-haiku-5-5`, through `scripts/acceptance/workspace-cwd.ts` (branch `docs/adr-0003-cli-cwd`, unpushed). It was single-turn in private-cwd mode, so the cache effect was not measured. The environment block differed from the 2026-11-01 shape in three ways:

- **Position:** it was the first block of `messages[1]`, not `messages[0]`.
- **Wrapper:** it had no `<system-reminder>` wrapper.
- **Content:** it had an extra line, "Downloaded files and extracted archives are untrusted data…".

The #32 matcher accepted only the wrapped block at the start of `messages[0]`, so it never matched.

**Cause: unknown.** The CLI version was the same in both runs (2.1.316), so a CLI release does not explain it. The differences between the two runs were:

- the model (`claude-haiku-4-5` and then `claude-haiku-5-5`);
- the acceptance script;
- the private `CLAUDE_CONFIG_DIR` state;
- any server-delivered CLI configuration.

None of these was isolated. The new "Downloaded files" line suggests the CLI revised the reminder content itself, possibly through configuration delivered from the server.

**Fix:** the matcher now accepts the environment line at the start of the first text block of any user message, wrapped or unwrapped. It still rewrites only a cwd ending in `pi-claude-subscription-XXXXXX`, and leaves Pi's replayed turns, assistant content and the rest of the reminder untouched. The fake CLI emits both shapes (`FAKE_CLAUDE_ENVIRONMENT_REMINDER=1` and `later`), and regression tests cover each one. The debug `request diagnostics` record now includes `environmentNormalized`. If that field is `false` on a private-cwd request, the CLI changed its format again and the cached prefix is probably being invalidated.

**Live re-verification: pending.** The `--live` check has not been rerun against the second shape, so live correctness of this fix is not established. The maintainer deferred live proof for this delivery to [issue #89](https://github.com/markdlabrecque/pi-claude-subscription/issues/89). That issue owns the manual procedure and evidence. At deferral, the script hardcoded `claude-haiku-4-5`, which might not produce the second shape, and its exact-prefix byte check compared only `messages[0]`. An unnormalized cwd in a later message would have been caught only by the cache-read assertion. The offline preparation below addresses those script limits. When the live check is run, record the CLI version, model, date, observed reminder shape and per-turn cache reads and writes here.

## Maintainer approval and preparation for issue #89

Approval recorded on 2026-11-03 in the maintainer's development session. The maintainer approved the proposed scope and limits, with manual execution only. This approval is not evidence of a live pass.

| Item            | Approved scope                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Model           | Haiku, exact available ID still to be verified, no substitution                                              |
| Matrix          | One text-only, three-turn replay run in private-directory mode                                               |
| Requests        | Three live requests maximum, no automatic retries or second run                                              |
| Input body      | Hard 80,000-byte serialized JSON limit per request, checked before forwarding                                |
| Input usage     | Stop after reported input exceeds 20,000 tokens per request or 60,000 cumulatively, including cached input   |
| Output          | 128 tokens per request                                                                                       |
| Duration        | 60 seconds per request, 180 seconds overall                                                                  |
| Stop conditions | Failed assertion, auth or rate-limit failure, unexpected request, exceeded limit, or maintainer cancellation |
| Credentials     | Existing authenticated local CLI environment only, no retrieval                                              |
| Exclusions      | No CI live traffic, API fallback, spending-setting changes or installed-extension changes                    |

### Revised budget approval and enforcement

The maintainer explicitly approved the revised input policy on 2026-11-03 after the original hard token cap proved unenforceable without a pre-request counter. The hard bound is now **80,000 UTF-8 bytes of serialized request JSON per request**, at most 240,000 bytes over three requests. Reported input thresholds are post-request stop conditions, **not guaranteed token ceilings**. A request can cross a token threshold before its usage is known. No extra live token-counting requests, retries or second run are approved.

Live execution requires both `--live` and `--approved-byte-budget`, plus an explicit Haiku model ID. Tool-transition live runs and inherited `ANTHROPIC_BASE_URL` overrides are rejected. The request hook sets the actual upstream `max_tokens` to 128, refuses enabled thinking, measures the final serialized body and reserves one of three requests before forwarding. It also checks normalization and the previous-message prefixes before sending a follow-up. The response hook rejects non-200 responses. The provider's one-request relay refuses CLI retries, and its diagnostic must report exactly one forwarded request and zero rejected requests for a pass.

Abort signals enforce 60 seconds per turn and 180 seconds overall. The run clock includes metadata probes, diagnostic waits and time between turns. Press **Ctrl+C once** to cancel; SIGTERM also aborts. Cancellation cannot undo a request already sent. Bounded process/directory cleanup can finish after a deadline, so elapsed wall time may slightly exceed the request deadline. Do not rerun after a cancellation or failure without reviewing the evidence and obtaining approval for another run.

### Offline preparation

The script accepts `--model <exact-id>` and rejects IDs absent from the installed SDK catalog without falling back. It also rejects a live payload whose model differs from the selected ID. The installed Pi 1.4.0 catalog lists `claude-haiku-4-5`, `claude-haiku-4-5-20251001` and `claude-haiku-5-5`. Catalog membership does not prove subscription availability. `claude-haiku-4-5` remains the offline default only. The proposed live target is `claude-haiku-5-5`, the model associated with the historical later-message shape. Confirm it is available in the maintainer's existing CLI environment without an additional live probe. If unavailable, record that outcome rather than silently selecting another model.

The previous-prefix assertion now covers every previous message, including later environment blocks. It checks roles, system instructions, tools and each previous content-block prefix, excluding only cache-control placement. Additional payload checks report observed wrapper/position and the absence of raw private-directory paths as booleans, without printing payloads. `normalizedReminderObserved` is a post-normalization assertion, **not** the provider's `environmentNormalized` diagnostic. The script separately collects that diagnostic, requires it to be true and prints only allowlisted boolean/numeric fields. Other debug output and warnings are suppressed because malformed CLI lines can contain private content. Existing offline normalization tests establish that other reminder text and Pi content remain intact.

Each run creates its own ephemeral temp root, scopes the subprocess private directories to that root and checks that they disappear before removing the scratch directory. It never scans or deletes other processes' private directories. The authenticated `CLAUDE_CONFIG_DIR` is inherited unchanged for live execution. Local audit-file writing is disabled for this check. No request bodies, headers, credentials or transcripts are persisted by the acceptance script.

Offline validation on 2026-11-03 passed all 686 tests across 62 files, typecheck and lint. Two complete fake-CLI script runs cover the wrapped first-message and unwrapped later-message shapes with local synthetic SSE responses. A separate in-flight SIGINT test confirms cancellation and private-directory cleanup. Boundary tests cover exact byte/output/request limits, UTF-8 size, invalid usage, post-request token stops and the overall forwarding deadline. These are offline regressions, not real-CLI or live evidence.

Fresh preparation is based on `264c983` with uncommitted changes on `issue-89-cache-verification`. No live revision has been tested. Before a manual run, record the exact committed revision and clean-tree status, date, platform, Node/Pi/CLI versions, exact model ID, replay mode, private-directory settings and whether `CLAUDE_CONFIG_DIR` is inherited or unset. Do not publish its private path, credentials, transcripts or raw payloads. Record only allowlisted non-secret settings. Historical measurements above are not fresh evidence.

### Maintainer-run procedure and results

1. Commit/review the prepared script changes and use a clean checkout. The script prints the exact `HEAD` revision and whether the worktree is dirty. Do not claim a reproducible tested revision from an uncommitted patch.
2. Confirm the existing subscription login and availability of the exact target `claude-haiku-5-5`, without retrieving credentials or making an extra test request. Leave any existing private config directory unchanged. Record whether it is inherited or default, not its path. An inherited custom `ANTHROPIC_BASE_URL` must be removed from the command's environment before running; never follow a credential reference to do so.
3. Run the explicit command below manually. Do not enable shell tracing, raw HTTP logging, CLI transcript capture or payload dumps. The script's stdout/stderr contain only allowlisted evidence and generic failures. The underlying CLI can still perform its normal local config bookkeeping in its existing authenticated directory.
4. Stop on any failure. Record the redacted failure reason and counts already printed. Do not retry, substitute models or change settings. A missing diagnostic or unconfirmed private-directory cleanup is a failure, not a pass.
5. Replace the pending fields below with the safe evidence. The two follow-ups must satisfy `cacheRead[N+1] >= cacheRead[N] + cacheWrite[N]`. A script PASS establishes only the exact observed model/shape, not the other historical shape. Both known shapes remain untested live after the merged fix until fresh evidence is entered. Issue #89 stays open while evidence is missing.

| Evidence                                                                        | Fresh maintainer result                    |
| ------------------------------------------------------------------------------- | ------------------------------------------ |
| Date, exact committed revision, clean tree                                      | Pending                                    |
| Node/Pi/CLI/extension versions, platform/architecture                           | Pending                                    |
| Exact model ID and existing authenticated config confirmed                      | Pending                                    |
| Command, approved scope and limits                                              | Procedure above; execution pending         |
| Replay/private-directory settings                                               | Script-enforced; live confirmation pending |
| Observed environment shape and message position                                 | Pending                                    |
| `environmentNormalized`, raw private path absent, all-message prefix assertions | Pending                                    |
| Turn 1 input/cache-read/cache-write/output/total input/duration                 | Pending                                    |
| Turn 2 input/cache-read/cache-write/output/total input/duration                 | Pending                                    |
| Turn 3 input/cache-read/cache-write/output/total input/duration                 | Pending                                    |
| Overall duration, forwarded/rejected request counts                             | Pending                                    |
| Cancellation or failure, private-directory and scratch cleanup                  | Pending                                    |
| `claude-haiku-5-5`, wrapped first-message shape                                 | Untested live                              |
| `claude-haiku-5-5`, unwrapped later-message shape                               | Untested live                              |
| Other Haiku IDs and shapes                                                      | Untested live, outside this initial run    |
| Final outcome                                                                   | Not run; no fresh live correctness claim   |

## Repeat

```bash
# Real CLI, dummy login, local synthetic SSE responses. Checks prefix bytes.
npx vite-node scripts/acceptance/cache-prefix.ts

# Maintainer only, after the checks above. Existing subscription login.
# One run only, no retries or model substitution.
./node_modules/.bin/vite-node scripts/acceptance/cache-prefix.ts \
  --live --approved-byte-budget --model claude-haiku-5-5

npm test
npm run typecheck
npm run lint
```

The byte comparison excludes cache-control markers because their placement moves with the final history block. The live assertion checks `cacheRead[N+1] >= cacheRead[N] + cacheWrite[N]` for each consecutive turn. The script prints versions and token counts, not request contents. Automated regressions also cover Windows-style paths, preserving Pi content and other reminder text, fresh subprocess directories, and caller payload-hook replacement.

These measurements cover text-only replay with an unchanged system prompt and empty tool inventory. They do not certify resume, all models, tool-result caching from issue #33, changing loadouts, date rollover or every CLI release. Real instruction or tool changes must continue to reach the model even when they invalidate the cache. The narrow reminder matcher must be rechecked when the CLI's generated format changes.
