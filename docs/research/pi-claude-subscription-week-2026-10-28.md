# Claude through Pi: transcript findings for October 21 to 28, 2026

The biggest concern is whether Claude receives Pi's instructions and workspace context correctly. Caching is working in this sample. Instruction loss, misleading workspace information, and an empty response recorded as success are stronger reasons for investigation than request speed alone.

## Scope and method

Window: October 21, 2026 at 07:55:53 PDT through October 28 at 07:55:53 PDT, a rolling seven days. Filtered by each message's timestamp and exact provider/API identity, `pi-claude-subscription`, rather than file modification time or mentions of Claude.

I scanned 556 saved Pi session files. Six contained matching responses. I also checked 17 runtime JSONL files and project-local orchestration log candidates under `.mill`, `.orch`, `.pi`, and session directories. No additional matching provider responses appeared. Direct Claude Code logs and OpenAI worker events were excluded. The project scan's 975 candidates included some fixtures, so that count is a search inventory, not a conversation denominator.

All 42 matching responses record `claude-sonnet-5-5`. There are no Haiku, Opus, or Fable responses in this window. Five sessions have substantive replies; the sixth has one empty reply. The selected records have no duplicate assistant entries or branch points. Mixed-model sessions were separated at the message level. Successful subagent sessions can be deleted, so this is an analysis of retained evidence, not a census of every request.

Times below are PDT. Source references such as S4:L8 refer to original JSONL line numbers, with paths at the end.

## Measurements

| Measure                              |  Recorded value | Interpretation                                                                                 |
| ------------------------------------ | --------------: | ---------------------------------------------------------------------------------------------- |
| Matching sessions                    |               6 | Only two dates have matching responses, October 22 and 24                                      |
| Assistant responses                  |              42 | 27 tool-using responses and 15 terminal `stop` responses                                       |
| User turns answered by this provider |              15 | 14 nonempty final replies and one empty reply, not an independently verified task-success rate |
| Tool calls                           |              29 | Every saved call is named `bash`                                                               |
| Explicit assistant errors/aborts     |               0 | Not proof of zero failures, see error-handling finding                                         |
| Empty final replies                  |               1 | Empty content and zero recorded usage, marked `stop`                                           |
| Tool results marked `isError`        |         3 of 29 | Includes a successful cleanup check that found no remaining core file                          |
| Median response duration             |   6.921 seconds | Provider-stream duration, not time to first token                                              |
| Longest response duration            |  17.434 seconds | This sample contains no recorded long stall                                                    |
| Sum of response durations            | 329.749 seconds | Excludes time spent by the human; does not include whole-task tool execution time              |
| Input-side tokens                    |         917,747 | Cumulative input + cache reads + cache writes, not unique context                              |
| Cache-read tokens                    |         742,315 | 80.9% of cumulative input-side tokens                                                          |
| Cache-write tokens                   |         175,350 | New or rewritten cached input                                                                  |
| Uncached input tokens                |              82 | Not the total amount of prompt context                                                         |
| Output tokens                        |          23,266 | Includes any usage counted as output by the provider                                           |

The stored cost totals $0.74543. This is a catalog-price estimate, not a subscription bill, quota measurement, or measured saving. Replay/resume mode and historical extension revision are not recorded in these transcripts.

## 1. Pi instructions disappear in the current provider path

All 29 tool calls use `bash`, including file reads with `cat` and `sed`, edits with `sed -i`, and file creation through heredocs. None calls Pi's `read`, `edit`, `write`, `grep`, `find`, `codemode`, or subagent tools. Pi's saved system messages list these tools and include the explicit rule, "Use read to examine files instead of cat or sed." Sources: S1:L4-L13, S2:L4-L41, S4:L4-L29.

That observation alone would not prove a provider bug. The source audit and a local probe supply stronger evidence:

- Modern Pi passes system instructions as messages with `role: system`, including named sections.
- `src/prompt-builder.ts:493-535` reads the legacy `context.systemPrompt` field instead.
- `src/prompt-builder.ts:231-259` ignores system-role messages during replay.
- The fallback reads one nearest `AGENTS.md`, or the global file if no nearer one exists. It does not recreate Pi's combined instructions. It also rewrites `.pi` references to `.claude`. See `src/prompt-builder.ts:648-678`.

I passed the actual recorded system message from S3 into today's prompt-builder functions, with a harmless synthetic user message. No CLI or model was invoked. The outgoing result omitted the read-tool instruction, the recorded cwd section, and the available-skills catalog. It retained the user marker. The generated system text was only 815 characters.

**Confirmed:** the current code loses these normalized Pi instructions. **Not established:** which exact code a long-lived process loaded for every historical response, or whether this accounts for every bash choice. The saved name `bash` also cannot distinguish a native Claude `Bash` proposal from an MCP proposal because both normalize to it.

This makes [version support issue #39](https://github.com/markdlabrecque/pi-claude-subscription/issues/39) a behavior-correctness question, not only a dependency-version decision. The installed Pi is 1.4.0; the extension declares 0.52 peers.

## 2. The private CLI directory becomes the model's apparent workspace

In a session whose saved cwd is the Sawmill checkout, Claude said:

> One caveat is that my working directory is `/tmp/pi-claude-subscription-7MrgV8`, which isn't a git repo.

Source: S3:L1 and L7. The user pasted this into the extension-building conversation, where the agent noticed the mismatch but guessed it was probably harmless. Source: S2:L46-L47.

The current extension deliberately starts the CLI in a private temporary directory. See `src/isolation.ts:28-46` and `src/process-manager.ts:81-101`. That isolation keeps host configuration out, but the loss of Pi's cwd section removes the countervailing explanation of the real workspace.

A later ticket-reading conversation began with `cd ~` and then three repo-scoped `gh-axi` calls. All three returned "not a git repository." The agent then retried with an explicit repository and later fetched the full ticket bodies. Sources: S4:L7-L12.

The direct cause of those three failures was the command's explicit `cd ~`; they do not prove Pi executed its tools in the CLI's temporary directory. The broader observation is that Claude had the wrong workspace model and spent a round recovering repo context. Keeping CLI isolation while accurately forwarding Pi's real tool cwd is the relevant design goal.

## 3. A blank reply is recorded as success, immediately before a model switch

On October 24 at 16:02:53, the foreman request produced:

- `content: []`
- Zero input, output, cache, and cost counters
- `stopReason: stop`
- No error message
- Duration of 3.129 seconds

At 16:02:59, 5.964 seconds later, the session changed to OpenAI. Sources: S5:L5-L8. The timing suggests friction but does not establish why the user switched.

The current provider has a matching failure shape. Its bridge begins with empty content, zero usage, and `stop`. The normal close path can return that untouched message without requiring a recognized successful completion. The empty-thinking guard requires at least one content block, so it misses a zero-block reply. Sources: `src/event-bridge.ts:79-97`, `src/provider.ts:401-485`. Early cancellation is another possible source of an empty successful result. These mechanisms were identified statically; the historical failure was not reproduced against the CLI.

There is a wider observability problem. `endStreamWithError` reports several non-HTTP failures as `done/stop`; existing partial content can hide the accompanying error text. Source: `src/provider.ts:232-267`. Therefore the sample's zero explicit assistant errors is not a clean reliability result. Zero recorded tokens also does not prove the upstream service did no work.

## 4. Cache reuse is good, but irrelevant history still inflates requests

Cache reads account for 80.9% of input-side tokens. There is no evidence here of every request rewriting the entire history without cache reuse.

The largest avoidable expansion came from a broad shell search while setting up `gh-axi`. A grep across `~/.codex/*` matched `history.jsonl` and returned old conversation text. One tool result was 46,612 characters. The next request's input-side context grew from 10,482 to 29,648 tokens. Sources: S2:L14-L17. This is an example of irrelevant transcript material entering another transcript through tool output.

By the end of that conversation the input-side context was 46,545 tokens. After a roughly 4.5-hour pause, a request recorded zero cache reads and 43,233 cache-write tokens. Sources: S2:L35-L37 and L47. This is consistent with a cold cache after idle time, but the transcript does not identify the retention policy or prove the cause.

The useful distinction is between cache efficiency and context quality. A cached prompt can still be mostly unnecessary material. Narrow searches of the actual hook files would have avoided the history import. These measurements do not justify switching to resume mode or estimating a subscription-quota saving.

## 5. Some extra work came from losing detail in batched output

The ticket-reading session required three batches before it could answer: the wrong-directory batch, a retry that returned truncated issue bodies, and a final fetch using `--full`. Sources: S4:L7-L13.

Later, one shell batch added labels to four tickets, removed `needs-triage` from one, and set dependencies. Its output showed the intermediate two-label state, then the final `ready-for-agent` state. The assistant misread the intermediate state as the result of the removal and asked permission to remove the label again. The user replied "yes on both," also approving a separate wording change. Sources: S4:L25-L30.

This is a concrete agent/output-reading mistake, not evidence of dropped tool results in the extension. Unlabeled lines in the shell batch made the mistake easier. Explicit per-operation labels and a final authoritative read-back would have made the result clearer.

## 6. Success flags alone hide ordinary command failures too

Only three tool results have `isError: true`. That is not a meaningful task-failure rate:

- One merely confirms the extracted crash core was cleaned up. S1:L13-L14.
- The three failed repo lookups are inside a pipeline whose tool result is `isError: false`. S4:L7-L8.
- The first typecheck attempt prints TypeScript error TS6064 and `exit 1`, but its shell tool result is also `isError: false`. A later attempt succeeds. S2:L39-L42.

For future transcript measurements, assistant terminal status, tool status, command output, and whether the task reached a substantive result need to remain separate. Otherwise a report will count blank completions as success and cleanup checks as failure.

## 7. Useful work did get through the extension

The sample is small, but it is not just unsuccessful experimentation:

- The crash investigation reached a substantive diagnostic answer in 35.8 seconds, without attributing the application crash to this extension. S1:L5-L15.
- The `pi-gh-axi` extension was written, typechecked in a later user-requested turn, and exercised in two fresh Pi sessions. S2:L26-L47, S3:L5-L7, S6:L5-L7.
- The hidden `gh-axi-context` message demonstrably reached Claude. The fresh-session responses accurately describe its snapshot. This is narrower evidence than saying all system context works; Pi converts custom messages to user messages. See installed Pi `docs/message-types.md`, CustomMessage.
- Ticket edits and dependencies were followed by recorded read-backs. The initial ticket answer took 34.5 seconds, including its unnecessary recovery calls. S4:L5-L13 and L14-L31.

Fourteen of fifteen user turns received nonempty final replies. That shows the bridge supports useful multi-step work, but neither the number nor the fast response times establishes answer correctness. Missing instructions may itself make a request lighter.

## Limits and interpretation

This is only six sessions, heavily concentrated in `gh-axi` setup and ticket maintenance. It cannot establish model-family differences, long-session stability, compaction behavior, quota consumption, time-to-first-token, or performance relative to direct Claude Code or OpenAI. No controlled comparison was run. The later AMD/NVIDIA correction in S3 belongs to OpenAI and was excluded from findings about this extension.

No matching extension responses appear after October 24 at 16:02 in the retained sources. That establishes absence from these records, not the reason for using another provider or proof that no unrecorded requests occurred.

The source audit is against current `main` at `44145425b3074c247bd5bf2f4565d4817a68e5b3`, whose commit predates the window. A commit date does not prove deployment. The prompt probe establishes current function behavior; historical raw CLI output and relay request diagnostics were not available in the selected sessions.

My priority from this evidence is faithful Pi instruction/workspace forwarding and truthful completion status before cache tuning. No extension code, settings, tickets, or production systems were changed.

## Evidence index

All paths are under `/home/mark/.pi/agent/sessions/`.

| Ref | Original relative path                                                                                            | Claude responses |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------: |
| S1  | `--home-mark-Work--/2026-10-22T13-29-33-995Z_01a163cd-7e2a-762a-841e-9cffc2e6fa9e.jsonl`                          |                5 |
| S2  | `--home-mark-Projects-sawmill-code-develop--/2026-10-24T15-34-06-949Z_01a16e8c-3d64-720d-b508-b05339c83dfd.jsonl` |               21 |
| S3  | `--home-mark-Projects-sawmill-code-develop--/2026-10-24T20-27-35-162Z_01a16f98-eb7a-74f7-b85d-7a9196f07fdf.jsonl` |                1 |
| S4  | `--home-mark-Projects-sawmill-code-develop--/2026-10-24T21-54-41-423Z_01a16fe8-aa8e-76e4-9bab-51d5c6a6c5dd.jsonl` |               13 |
| S5  | `--home-mark-Projects-sawmill-code-develop--/2026-10-24T23-02-46-696Z_01a17027-00a8-73c4-a812-1f6d12b7aca6.jsonl` |                1 |
| S6  | `--home-mark-.config-sawmill--/2026-10-24T20-26-33-671Z_01a16f97-fb46-7317-a7a0-5bf2b0721c06.jsonl`               |                1 |

Analysis scratch files are at `/tmp/pi-claude-week-2026-10-28/`: `analyze.py`, `metrics.json`, `prompt-probe.ts`, and `code-audit.md`. Scratch evidence includes private transcript text and is not intended for publication. This report is stored in the personal research directory, outside the extension repository. No report or transcript was published.
