# Spec: Pi Claude subscription provider

## Purpose

This extension lets Pi coding agents run on a Claude Pro/Max subscription instead of an API key. It drives the official `claude` CLI as a model client. Pi stays the only agent harness: it owns the agent loop, tool execution, approvals and compaction.

The upstream `pi-claude-cli` provider gets close, but Claude Code can interfere with Pi's operation in several ways. This spec covers how we prevent that:

- One Pi turn can become more than one request to Anthropic, because the CLI sometimes makes extra generations, and break-early can't undo a request already sent.
- The host's Claude Code setup (CLAUDE.md, memory, skills, hooks, plugins, settings, built-in tools) can leak into Pi's requests.
- `--resume` relies on CLI session files on local disk. Those are lost in throwaway containers and stateless orchestrators, so continuity can't depend on them.
- When Claude calls a tool that wasn't offered (made up, or a deferred tool it saw by name), the whole turn can fail.
- Expired auth, rate limits, timeouts and cancels don't give clear errors, and can leave stray processes, temp directories or open ports behind.

Pi sessions often run unattended in lightweight containers, so any failure that needs a human to notice is a bug.

## Solution

A renamed fork of `rchern/pi-claude-cli` (package `pi-claude-subscription`) that installs beside the original. Claude Code carries exactly one model request per Pi turn and returns text, thinking and tool calls, nothing more.

Core behaviour:

1. **Provider backed by `claude -p`.** Haiku, Sonnet, Opus and Fable are exposed under one provider, with streaming text, thinking and tool calls, and two-way tool name and argument mapping.
2. **Single-request relay guard.** A loopback relay forwards only the first Messages request per Pi turn and rejects the rest.
3. **Per-request isolation.** No built-in tools, no host config, a fresh private temp directory, and Pi's system prompt replacing Claude Code's.
4. **Stateless replay by default.** History is rebuilt from Pi each turn. `resume` is optional, and falls back to `replay` if the session is missing or corrupt.
5. **Tolerant handling of tool calls outside the inventory.** They are passed to Pi, so Pi's normal unknown-tool error lets the model correct itself.
6. **Clear errors and full cleanup.** Auth, rate-limit, timeout and cancel cases each give a clear error and leave nothing behind.

## User Stories

### Models and streaming

1. As a Pi user, I want Haiku, Sonnet, Opus and Fable exposed under one provider, so that I can pick a model per task.
2. As a Pi user, I want text, thinking and tool-call tokens streamed to Pi as they arrive, so that the session feels live.
3. As a Pi user, I want tool names and arguments mapped both ways between Claude and Pi, so that Claude's tool calls land on the right Pi tool with the right arguments.
4. As a Pi user, I want images and file attachments either passed through cleanly or rejected with a clear error, so that they're never silently dropped.

### One request per turn

5. As a Pi user, I want each Pi turn to send exactly one Messages request to Anthropic, so that unattended runs never burn extra subscription usage.
6. As an operator, I want any second or later request in a turn rejected locally with an error and logged, so that I can see when the CLI tried to do more than asked.
7. As an operator, I want break-early kept as a second guard behind the relay, so that a slip in one layer is caught by the other.
8. As an operator, I want the relay bound to 127.0.0.1 on a random free port, so that nothing else on the network or host can use it and parallel requests don't collide.
9. As an operator, I want the relay shut down when the request ends or the process dies, so that no ports are left open.
10. As a Pi user, I want auth headers passed through untouched and never read, stored or logged, so that my OAuth token is never exposed.
11. As an operator, I want a relay log line per request showing upstream count per turn, so that I can verify the one-request rule over long runs.

### Isolation from Claude Code

12. As a Pi user, I want all Claude Code built-in tools disabled, so that the only tools Claude sees are Pi's.
13. As a Pi user, I want zero tools executed by Claude Code itself, so that Pi stays the only harness and approvals stay in Pi.
14. As a Pi user, I want user, project and local settings, CLAUDE.md, memory files, skills, hooks, plugins and slash commands kept out of every request, so that my host setup doesn't change Pi's behaviour.
15. As a Pi user, I want each request to start in a fresh private temp directory that is deleted afterwards, even on error, so that nothing from one request leaks into the next and no temp dirs pile up.
16. As a Pi user, I want Pi's system prompt to replace Claude Code's, not be appended to it, so that the model follows Pi's instructions only.
17. As a maintainer, I want a test that plants markers in a global CLAUDE.md, a skill and a hook and proves none reach the request, so that isolation stays proven as the CLI changes.

### Resume or replay

18. As an operator, I want `replay` as the default mode, so that each turn is stateless and works in throwaway containers and stateless orchestrators.
19. As an operator, I want `replay` to rebuild the full conversation from Pi's history every turn, including tool calls and tool results, so that no CLI session state is needed.
20. As an operator, I want a session started in one container to finish in a fresh container with no CLI session files, so that losing a container never loses the session.
21. As an interactive user, I want a `resume` mode, so that I can save tokens on long sessions on one machine.
22. As an interactive user, I want a missing or corrupt resumed session to fall back to `replay` for that turn, so that a lost session file never fails the turn.
23. As a Pi user, I want the mode set through a single setting, so that switching is a config change only.

### Tool calls outside the inventory

24. As a Pi user, I want a tool call for a tool that wasn't offered to never fail the turn, so that one hallucinated name doesn't kill a long run.
25. As a Pi user, I want any `mcp__<server>__` prefix stripped from such a call before Pi receives it, so that Pi sees the bare tool name.
26. As a Pi user, I want Pi's normal unknown-tool error, listing the valid tools, returned as the tool result, so that the model can correct itself on the next turn.
27. As a maintainer, I want a regression test for a hallucinated tool name, so that this stays fixed.

### Errors and lifecycle

28. As an operator, I want expired or missing auth to give one clear error telling me to run `claude auth login`, with no retry, so that I fix it once instead of watching it loop.
29. As an operator, I want rate-limit and usage-limit responses mapped to Pi's rate-limit errors with any retry-after kept, so that Pi's own backoff works.
30. As an operator, I want a per-request timeout, so that a hung CLI never stalls a session.
31. As an operator, I want the whole CLI process tree killed when the timeout fires or Pi cancels, so that no stray processes are left.
32. As an operator, I want expired auth, a rate limit, a timeout and a cancel to each leave no stray processes, temp directories or open ports, so that long runs don't leak resources.
33. As an operator, I want the installed CLI version checked at startup with a warning when it's outside the tested range, so that I know when a CLI update might break things.

### Logging and privacy

34. As a Pi user, I want tokens, prompts and tool arguments never written to logs by default, so that sensitive content stays private.
35. As a developer, I want a debug log behind an explicit flag, so that I can diagnose problems when I choose to.

## Implementation Decisions

- **Base.** Fork `rchern/pi-claude-cli` (not `@saccolabs/pi-claude-cli`, which runs native tools and loads host config). The package and provider ID are renamed so both can be installed. MIT licence kept and upstream credited in the README.
- **Kept from upstream.** Provider registration exposing all Claude models; spawning `claude -p` with the stream-json wire protocol; two-way tool-name and argument mapping; the schema-only MCP server that advertises Pi's tools and never runs them; break-early. Each is checked to confirm it behaves as documented, and changed only where needed.
- **Relay module (new).** A loopback HTTP relay scoped to one request. Interface: start returns a base URL; stop closes it; it exposes the count of upstream and rejected requests. The CLI is pointed at it through its base-URL setting. The first Messages request is forwarded; later ones get a local error and a log line. Auth headers are passed through opaquely. It binds 127.0.0.1 on a random free port, and closes on request end and process exit. If the CLI turns out to ignore a custom base URL under subscription login, this decision is revisited.
- **Isolation module (new, or folded into the spawner).** Builds the CLI argument list and environment for one request: built-in tools disabled; all setting sources and CLAUDE.md, memory, skills, hooks, plugins and slash commands off; Pi's system prompt as a replacement; MCP config pointing only at the schema-only server; working directory set to a fresh private temp dir that is always removed. The exact flags depend on the current CLI release and are confirmed by testing.
- **Session mode setting.** One setting, `replay` | `resume`, default `replay`. In `replay`, the full Pi history (including tool calls and results) is rebuilt into a single `claude -p` call with no CLI session state. In `resume`, upstream behaviour is kept, and a missing or corrupt session falls back to `replay` for that turn.
- **Unknown tool calls.** The tool-mapping layer never throws on a name outside the inventory. It strips any `mcp__<server>__` prefix and emits the call to Pi unchanged, so Pi's unknown-tool error drives self-correction.
- **Error mapping.** Auth failures map to one non-retryable error mentioning `claude auth login`. Rate and usage limits map to Pi's rate-limit error with retry-after kept. Timeouts and cancels kill the full process tree (process group on macOS and Linux) and then run the same cleanup as a normal end.
- **CLI version check.** At startup, read the installed CLI version and warn outside a tested range kept in the package.
- **Logging.** Default logs contain no tokens, prompts or tool arguments. A debug flag enables fuller logging.
- **Attachments.** Pass through if the CLI handles them; otherwise return a clear error.
- **Platforms.** Linux (including lightweight containers with the CLI's credentials mounted read-only) and macOS. On Windows, use WSL.
- **Constraints.** Only the unmodified official `claude` executable is driven. No token extraction, no direct Anthropic calls, no patching or wrapping the binary. Tool names are mapped honestly and not spoofed as Claude Code's own tools.

## Testing Decisions

- **Good tests** check behaviour seen from outside the provider: what Pi receives (stream events, errors, tool calls) and what reaches the upstream (request count, request contents). They don't check internal function calls or argument shapes.
- **One main seam: the provider's stream entry point.** Tests call the provider the way Pi does (context, history, tools in; event stream out). Two things around it are swapped:
  - the upstream Anthropic endpoint, replaced by a fake HTTP server behind the relay, which records every request and returns scripted responses (normal, tool call, made-up tool call, 401, 429 with retry-after, hang);
  - for fast unit-level runs, the `claude` executable path, replaced by a small fake CLI that speaks stream-json. The real CLI is used in acceptance runs.
- **Tests planned:**
  - Relay: a turn where the CLI attempts a second generation sends exactly one request upstream and logs the rejection.
  - Isolation: markers in a global CLAUDE.md, a skill and a hook never appear in the upstream request; no built-in tools are offered.
  - Replay: a multi-turn session with tool results, replayed in a fresh environment with no session files, reaches the upstream with full history.
  - Resume fallback: a missing session file falls back to replay without failing the turn.
  - Unknown tool: a made-up tool name (with and without an `mcp__` prefix) reaches Pi as a tool call, gets Pi's error, and the next turn retries correctly.
  - Errors and cleanup: expired auth, rate limit, timeout and cancel each give the right Pi error and leave no stray processes, temp dirs or open ports.
- **Acceptance runs** (real CLI, real subscription): 50 consecutive tool-using turns with exactly one upstream request each and zero Claude Code tool executions; cross-container replay; full suite on macOS and Linux.
- **Prior art.** Use the test runner and style upstream `pi-claude-cli` already has.

## Out of Scope

- Running Claude Code's own tools or sub-agents through Pi. Pi stays the only harness.
- Publishing to npm or the Pi package site.
- Falling back to an Anthropic API key. Pi's own Anthropic provider covers that.
- General Pi extension compatibility beyond what the CLI path itself affects. Extensions that edit the raw API request are not supported under this provider.
- Native Windows support.

## Further Notes

- As of Anthropic's Help Center article [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), `claude -p` and third-party app usage still draw from the user's subscription limits (billing change paused 15 June 2026; Max and Team plans gained monthly API credits on 7 October 2026). This is a billing statement, not a licence. Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) still limits OAuth credentials to the subscriber's own use. Use this provider for an individual's own subscription only, and re-check both pages before relying on this.
- Design references: Hermes `claude-subscription-directsdk` (including its PR #93 and PR #49 for unknown-tool handling) is the main reference; where it disagrees with upstream, follow it unless upstream's approach is at least as safe. `agustinsacco/pi-claude-cli` is worth reading for its empty-response fix and local-socket MCP proxy, but not for its native-tools or settings-loading behaviour.
- Open questions to settle by testing against the current CLI: which flags disable each piece of host config and whether any still loads; the most reliable way to feed a full replayed history into one `claude -p` call; whether the CLI honours a custom base URL under subscription login; whether `replay` costs noticeably more usage than `resume` on long sessions.
