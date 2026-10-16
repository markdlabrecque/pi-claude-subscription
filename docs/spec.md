# Spec: Pi Claude subscription provider

## Problem Statement

I want Pi to run on my Claude Pro/Max subscription instead of an API key. The existing `pi-claude-cli` provider gets close: it drives the official `claude` CLI and maps Pi's tools through a schema-only MCP server. But it is not safe to leave running unattended.

- One Pi turn can turn into more than one request to Anthropic, because the CLI sometimes tries extra generations, and break-early can't undo a request already sent.
- My host's Claude Code setup (CLAUDE.md, memory, skills, hooks, plugins, settings, built-in tools) can leak into Pi's requests.
- `--resume` relies on CLI session files on the local disk. That breaks in throwaway containers, a stateless orchestrator, and when moving between macOS and Linux.
- When Claude calls a tool that wasn't offered (made up, or a deferred tool it saw by name), the whole turn can fail.
- Expired auth, rate limits, timeouts and cancels don't give clear errors, and can leave stray processes, temp directories or open ports behind.

Overnight agent crews run in lightweight Docker containers on macOS and Linux. Anything that needs a human to notice and step in is a bug.

## Solution

A fork of `rchern/pi-claude-cli`, renamed so it installs beside the original (for example `pi-claude-subscription`). It stays a pure model client: Pi owns the agent loop, every tool execution, approvals and compaction. Claude Code carries exactly one model request per Pi turn and returns text, thinking and tool calls, nothing more.

On top of what upstream already does well, the fork adds:

1. A **single-request relay guard**: a loopback relay that forwards only the first Messages request per Pi turn and rejects the rest.
2. **Per-request isolation**: no built-in tools, no host config, a fresh private temp directory, and Pi's system prompt replacing Claude Code's.
3. **Resume or replay**: a setting with `replay` (default, stateless, rebuilds history from Pi) and `resume` (upstream behaviour, for interactive use), with automatic fallback to `replay` when a session is missing or corrupt.
4. **Tolerant handling of tool calls outside the inventory**: passed to Pi as is, so Pi's normal unknown-tool error lets the model correct itself.
5. **Hardening**: clear auth errors, rate-limit mapping, timeouts and cancels that clean up fully, an API-key fallback by config, a CLI version check, and container support with read-only credentials.

## User Stories

### Setup and install

1. As Mark, I want the work done in my own fork of `rchern/pi-claude-cli` with an `upstream` remote, so that I can pull in later upstream fixes.
2. As Mark, I want `main` left matching upstream at the fork point, so that my changes are easy to diff against the original.
3. As Mark, I want the package and provider ID renamed, so that I can install it beside the original without a clash.
4. As Mark, I want the MIT licence kept and upstream credited in the README, so that the fork respects its source.
5. As Mark, I want a README section on setup, settings and known limits (including "On Windows, use WSL"), so that I can set it up again on a new machine or container without re-reading code.
6. As Mark, I want the spike findings (which flags disable which host config, how history is fed in, whether a custom base URL works under subscription login, replay vs resume usage cost) written up in the README, so that the reasoning behind each choice is kept.

### Model selection and streaming

7. As an orchestrator, I want Haiku, Sonnet, Opus and Fable exposed under one provider, so that I can pick a model per task.
8. As a Pi user, I want text, thinking and tool-call tokens streamed to Pi as they arrive, so that the session feels live.
9. As a Pi user, I want tool names and arguments mapped both ways between Claude and Pi, so that Claude's tool calls land on the right Pi tool with the right arguments.

### One request per turn

10. As Mark, I want each Pi turn to send exactly one Messages request to Anthropic, so that unattended runs never burn extra subscription usage.
11. As Mark, I want any second or later request in a turn rejected locally with an error and logged, so that I can see when the CLI tried to do more than asked.
12. As Mark, I want break-early kept as a second guard behind the relay, so that a slip in one layer is caught by the other.
13. As Mark, I want the relay bound to 127.0.0.1 on a random free port, so that nothing else on the network or host can use it and parallel requests don't collide.
14. As Mark, I want the relay shut down when the request ends or the process dies, so that no ports are left open.
15. As Mark, I want auth headers passed through untouched and never read, stored or logged, so that my OAuth token is never exposed.
16. As an operator, I want a relay log line per request showing upstream count per turn, so that I can verify the one-request rule over long runs.

### Isolation

17. As Mark, I want all Claude Code built-in tools disabled, so that the only tools Claude sees are Pi's.
18. As Mark, I want zero tools executed by Claude Code itself, so that Pi stays the only harness and approvals stay in Pi.
19. As Mark, I want user, project and local settings, CLAUDE.md, memory files, skills, hooks, plugins and slash commands kept out of every request, so that my host setup doesn't change Pi's behaviour.
20. As Mark, I want each request to start in a fresh private temp directory that is deleted afterwards, even on error, so that nothing from one request leaks into the next and no temp dirs pile up.
21. As a Pi user, I want Pi's system prompt to replace Claude Code's, not be appended to it, so that the model follows Pi's instructions only.
22. As Mark, I want a test that plants markers in a global CLAUDE.md, a skill and a hook and proves none reach the request, so that isolation stays proven as the CLI changes.

### Resume or replay

23. As an orchestrator, I want `replay` as the default mode, so that each turn is stateless and works in throwaway containers.
24. As an orchestrator, I want `replay` to rebuild the full conversation from Pi's history every turn, including tool calls and tool results, so that no CLI session state is needed.
25. As Mark, I want a session started in one container to finish in a fresh container with no CLI session files, so that crews can move between machines.
26. As an interactive user, I want a `resume` mode, so that I can save tokens on long sessions on one machine.
27. As an interactive user, I want a missing or corrupt resumed session to fall back to `replay` for that turn, so that a lost session file never fails the turn.
28. As Mark, I want the mode set through a single setting, so that switching is a config change only.

### Tool calls outside the inventory

29. As Mark, I want a tool call for a tool that wasn't offered to never fail the turn, so that one hallucinated name doesn't kill an overnight run.
30. As Pi, I want any `mcp__<server>__` prefix stripped from such a call before I receive it, so that I see the bare tool name.
31. As the model, I want Pi's normal unknown-tool error, listing the valid tools, returned as the tool result, so that I can correct myself on the next turn.
32. As Mark, I want a regression test modelled on Hermes PR #93, so that this stays fixed.

### Errors and lifecycle

33. As an operator, I want expired or missing auth to give one clear error telling me to run `claude auth login`, with no retry, so that I fix it once instead of watching it loop.
34. As an orchestrator, I want rate-limit and usage-limit responses mapped to Pi's rate-limit errors with any retry-after kept, so that Pi's own backoff works.
35. As an operator, I want a per-request timeout, so that a hung CLI never stalls a crew.
36. As an operator, I want the whole CLI process tree killed when the timeout fires or Pi cancels, so that no stray processes are left.
37. As an operator, I want expired auth, a rate limit, a timeout and a cancel to each leave no stray processes, temp directories or open ports, so that long runs don't leak resources.
38. As Mark, I want a config switch to fall back to an Anthropic API key through Pi's normal Anthropic provider, without reinstalling anything, so that I can keep working when subscription limits run out.
39. As an operator, I want the installed CLI version checked at startup with a warning when it's outside the tested range, so that I know when a CLI update might break things.

### Platforms and containers

40. As Mark, I want the provider to work on macOS and Linux, so that I can run it on my laptop and on servers.
41. As an operator, I want it to run inside a lightweight container with the CLI's credentials mounted read-only, so that containers can't modify my login.
42. As Mark, I want the test suite to pass on both macOS and Linux, so that platform bugs are caught before a crew hits them.

### Logging and privacy

43. As Mark, I want tokens, prompts and tool arguments never written to logs by default, so that sensitive content stays private.
44. As a developer, I want a debug log behind an explicit flag, so that I can diagnose problems when I choose to.

### Pi extension compatibility

45. As a Pi user, I want custom tools, commands, hooks, UI extensions and anything else inside Pi's loop to work unchanged, so that switching provider doesn't break my setup.
46. As a Pi user, I want extensions that edit the raw API request (custom params, prompt-caching tweaks, header changes) detected where possible and warned about clearly, so that I'm not silently surprised.
47. As a Pi user, I want images and file attachments either passed through cleanly or rejected with a clear error, so that they're never silently dropped.
48. As Mark, I want a test that loads a real third-party Pi extension with custom tools and runs a tool-using turn, so that compatibility is proven, not assumed.

## Implementation Decisions

- **Fork and rename.** Fork `rchern/pi-claude-cli` (not `@saccolabs/pi-claude-cli`, which runs native tools and loads host config). Rename package and provider ID. Work on a branch; `main` stays at the fork point.
- **Kept from upstream.** Provider registration exposing all Claude models; spawning `claude -p` with the stream-json wire protocol; two-way tool-name and argument mapping; the schema-only MCP server that advertises Pi's tools and never runs them; break-early. Read each to confirm it behaves as documented; change only where a work item needs it.
- **Design reference.** Hermes `claude-subscription-directsdk` is the main reference. Where it disagrees with upstream, follow Hermes unless upstream's approach is shown to be at least as safe.
- **Relay module (new).** A loopback HTTP relay scoped to one request. Interface: start → returns a base URL; stop → closes it; exposes the count of upstream and rejected requests. The CLI is pointed at it through its base-URL setting. First Messages request is forwarded; later ones get a local error and a log line. Auth headers are passed through opaquely. Binds 127.0.0.1, random free port, closed on request end and process exit. If the spike finds the CLI ignores a custom base URL under subscription login, this decision is revisited before work item 1.
- **Isolation module (new or folded into the spawner).** Builds the CLI argument list and environment for one request: built-in tools disabled, all setting sources and CLAUDE.md/memory/skills/hooks/plugins/slash commands off, Pi's system prompt as a replacement, MCP config pointing only at the schema-only server, working directory set to a fresh private temp dir that is always removed. The exact flags come from the spike, since they depend on the current CLI release.
- **Session mode setting.** One setting, `replay` | `resume`, default `replay`. In `replay`, the full Pi history (including tool calls and results) is rebuilt into a single `claude -p` call with no CLI session state. The exact encoding is chosen in the spike. In `resume`, upstream behaviour is kept, and a missing or corrupt session falls back to `replay` for that turn.
- **Unknown tool calls.** The tool-mapping layer never throws on a name outside the inventory. It strips any `mcp__<server>__` prefix and emits the call to Pi unchanged, so Pi's unknown-tool error drives self-correction.
- **Error mapping.** Auth failures map to one non-retryable error mentioning `claude auth login`. Rate and usage limits map to Pi's rate-limit error with retry-after kept. Timeouts and cancels kill the full process tree (process group on macOS/Linux) and then run the same cleanup as a normal end.
- **API-key fallback.** A config switch routes requests to Pi's normal Anthropic provider. No reinstall.
- **CLI version check.** At startup, read the installed CLI version and warn outside a tested range kept in the package.
- **Logging.** Default logs contain no tokens, prompts or tool arguments. A debug flag enables fuller logging.
- **Raw-request extensions.** Where detectable, log one clear warning that the setting is ignored under this provider.
- **Attachments.** Pass through if the spike shows the CLI handles them; otherwise return a clear error.
- **Constraints.** Only the unmodified official `claude` executable is driven. No token extraction, no direct Anthropic calls, no patching or wrapping the binary. Tool names are mapped honestly, never disguised.
- **Order of work.** Fork → spike with request logging → isolation → relay → unknown tools → resume/replay → hardening → acceptance run on macOS and Linux.

## Testing Decisions

- **Good tests** check behaviour seen from outside the provider: what Pi receives (stream events, errors, tool calls) and what reaches the upstream (request count, request contents). They don't check internal function calls or argument shapes.
- **One main seam: the provider's stream entry point.** Tests call the provider the way Pi does (context, history, tools in; event stream out). Two things around it are swapped:
  - the upstream Anthropic endpoint, replaced by a fake HTTP server behind the relay, which records every request and returns scripted responses (normal, tool call, made-up tool call, 401, 429 with retry-after, hang);
  - for fast unit-level runs, the `claude` executable path, replaced by a small fake CLI that speaks stream-json. The real CLI is used in the acceptance runs.
- **Tests planned:**
  - Relay: a turn where the CLI attempts a second generation sends exactly one request upstream and logs the rejection.
  - Isolation: markers in a global CLAUDE.md, a skill and a hook never appear in the upstream request; no built-in tools are offered.
  - Replay: a multi-turn session with tool results, replayed in a fresh environment with no session files, reaches the upstream with full history.
  - Resume fallback: a missing session file falls back to replay without failing the turn.
  - Unknown tool: a made-up tool name (with and without an `mcp__` prefix) reaches Pi as a tool call, gets Pi's error, and the next turn retries correctly (modelled on Hermes PR #93).
  - Errors and cleanup: expired auth, rate limit, timeout and cancel each give the right Pi error and leave no stray processes, temp dirs or open ports.
  - Extension compatibility: a real third-party Pi extension with custom tools runs a tool-using turn.
- **Acceptance runs** (real CLI, real subscription): 50 consecutive tool-using turns with exactly one upstream request each and zero Claude Code tool executions; cross-container replay; full suite on macOS and Linux.
- **Prior art.** Use whatever test runner and style upstream `pi-claude-cli` already has. Hermes' tests for PR #93 and PR #49 are the model for the unknown-tool tests.

## Out of Scope

- Running Claude Code's own tools or sub-agents through Pi. Pi stays the only harness.
- Publishing to npm or the Pi package site.
- Extracting the OAuth token, calling Anthropic directly, or patching/wrapping the `claude` binary.
- Renaming or disguising tool names.
- Supporting extensions that edit the raw API request (they get a warning only).
- Native Windows support. The README tells Windows users to run it under WSL, where the Linux build works as is.

## Further Notes

- Subscription use via `claude -p` and third-party apps is allowed under Anthropic's policy update of 15 June 2026.
- `agustinsacco/pi-claude-cli` is worth reading for its empty-response fix and local-socket MCP proxy, but not its native-tools or settings-loading behaviour.
- Open questions for the spike: which CLI flags disable each piece of host config and whether any still loads; the most reliable way to feed a full replayed history into one `claude -p` call; whether the CLI honours a custom base URL under subscription login; whether `replay` costs noticeably more usage than `resume` on long sessions.
