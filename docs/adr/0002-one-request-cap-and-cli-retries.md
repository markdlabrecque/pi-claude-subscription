---
status: proposed
date: 2026-10-29
---

# The one-request cap and the CLI's own retries

The relay (`src/relay.ts`) forwards only the first `POST /v1/messages` of each Pi turn and answers any later one locally with a `400`. That cap also catches follow-up requests the Claude CLI may make by itself: a retry after a 5xx or 529, a retry after a stream is cut off, and a continuation after a `max_tokens` stop. This ADR records what happens today in each case and the options for changing it.

Status: **Proposed**. The maintainer has decided, on [issue #36](https://github.com/markdlabrecque/pi-claude-subscription/issues/36), to keep the hard cap for now: failures surface as explicit failures with any partial output and known usage, and no automatic retries, backoff retries or output-limit continuations are added to the CLI/relay path. The options below stay on record so a later decision can be made from data on failure frequency and impact. Any relaxation needs a new maintainer decision.

## How this was observed

`tests/relay-retries.test.ts` drives the real relay and provider against the fake upstream and fake CLI in `tests/harness/`. Pi SDK: `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` 1.4.0 (normalized 1.x contexts, per [ADR-0001](0001-pi-1x-only-support.md)). Extension: `pi-claude-subscription` 0.3.1.

The fake CLI models the retries as assumptions: it retries once after a 5xx or an unreadable body, and, when `FAKE_CLAUDE_CONTINUE_ON_MAX_TOKENS` is set, sends one continuation after `max_tokens`. These were **not confirmed on the real Claude CLI**. No live requests were authorized, so the real CLI's retry count, timing and continuation behaviour remain open.

## Findings

| Case                                 | Upstream requests | Rejected             | What Pi receives                                                               | What the user sees                                                |
| ------------------------------------ | ----------------- | -------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 529, then 500                        | 1                 | 1                    | `stopReason: "error"`, `errorMessage: "Claude API returned 529 (overloaded)."` | A clear overloaded error. The 500 is never reached.               |
| Stream cut off before `message_stop` | 1                 | 1 (a later retry)    | Nothing until the CLI times out                                                | A hang, then a timeout error. The cut-off itself is not reported. |
| `stop_reason: "max_tokens"`          | 1                 | 1 (the continuation) | `stopReason: "length"`, the partial text, no error                             | A shorter reply ended as a length completion                      |

### 529, then 500

The relay records the first failed status (529) and passes it to the CLI. The CLI's retry is rejected locally, so no second generation is spent. The provider ends the turn as an error with the 529 message, keeping any partial output. "Overloaded" is retryable under Pi's own retry policy (`settings.retry`). A Pi retry starts a new turn with a new relay, so it gets its own single upstream request. This case already gives a clear error.

### Stream cut off before `message_stop`

**Finding:** when upstream drops mid-body, the relay neither ends nor destroys the CLI's response (`up.pipe(res)` does not close `res` when `up` aborts). The CLI's request stays open, so the CLI never sees the failure and never reaches its retry. `relay.failure` stays unset because the status was 200, so the turn is not recorded as an upstream failure. The user waits until the inactivity timeout (180 s) or the per-request timeout kills the CLI, then sees a timeout error that does not name the cut-off. A retry that does arrive is still rejected (`upstream=1 rejected=1`).

This is not a silent truncation, because the turn ends in an error, but the error is late and misleading. Terminal failure reporting is owned by #41 and its children. This finding is recorded here and not fixed by this ADR.

### `max_tokens`

A completed length-limited response is a length completion, not a failure. Pi receives `stopReason: "length"` with the partial text and no error message. If the CLI sends a continuation, the relay rejects it, and the reply Pi receives is the first response only. Whether the real CLI continues after `max_tokens` is unconfirmed. If it does, the user gets the first segment of a longer answer. Pi marks it as length-limited but does not say a continuation was refused. Treat this as a finding: it is a truthful length stop, not a clear error.

## Options

### 1. Keep the hard cap (no changes)

One Pi turn can never spend more than one generation, and failures surface to Pi, whose own retry policy decides whether to try again.

- Cost: none.
- Risk: transient 5xx/529 errors that the CLI could have absorbed reach the user as failed turns. Pi's own retries, if enabled, already cover most of this. Length-limited replies are not continued.

### 2. Don't count failed upstream responses toward the cap

A response with status >= 400, or a stream cut off before `message_stop`, would not use up the turn's one request. The CLI's retry would then go upstream.

- Cost: the relay must know when a response failed. Statuses are easy. A cut-off needs the relay to notice the aborted body and parse the stream far enough to see `message_stop`. It also needs a separate bound on retries, or a misbehaving CLI could retry indefinitely.
- Risk: a cut-off stream may already have generated (and been billed for) most of a response, so a retry can spend a second generation. Retries stack with Pi's own retry policy, multiplying attempts. It weakens the guarantee the relay exists to give.

### 3. Allow `max_tokens` continuations up to a small limit

After a response that ends with `stop_reason: "max_tokens"`, allow a fixed small number (for example 1 or 2) of further requests.

- Cost: the relay must parse the upstream stream to read `stop_reason`, and tell a continuation apart from any other extra request. That is body-guessing, which the relay avoids today.
- Risk: each continuation is a full generation, so a turn can spend several. Pi would see one merged reply, and the provider would need to report usage across all of them. It also changes what a length completion means to Pi.

## Consequences

- The cut-off finding should be fixed so a dropped stream ends promptly as an explicit failure with partial output and usage preserved. That belongs to #41's terminal-failure work and needs no change to the cap.
- Before revisiting options 2 or 3, gather data on how often 5xx/529, cut-offs and `max_tokens` stops happen, and confirm the real CLI's retry and continuation behaviour against a logging upstream.
