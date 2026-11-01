# First tool-result cache verification

Investigation and acceptance for [issue #33](https://github.com/markdlabrecque/pi-claude-subscription/issues/33), run on Linux on 2026-11-01. Tested Pi AI and coding-agent packages 1.4.0, extension manifest 0.3.1, Claude Code CLI 2.1.316, Node 24.20.0 and model `claude-haiku-4-5`.

This change is based on `acbb30a`, the [issue #32 fix](cache-prefix-verification.md). That prerequisite removes the random private cwd from the CLI-generated cache prefix. Without it, the cwd independently invalidates the message prefix.

## Reproduction and cause

The regression uses normalized Pi 1.x context with effective tool declarations, a schema-only MCP inventory, actual provider tool-call output, and a supported text tool-result message. It checks the request before and after the first tool result. Both cases failed before the fix: a tool call as the first reply, and a tool call after a plain-text reply.

The first differing field was the system prompt. `buildSystemPrompt` inserted a new tool-result instruction only once the history contained a `toolResult`. This still happened after the Pi 1.x instruction and inventory migration. It was not an assistant-thinking serialization change or the custom-tool prompt shortcut. Replay uses `buildReplayPrompt`, not that shortcut.

Replay now includes conditional tool-result guidance from the first request. Its text says what to do _if_ history contains results, rather than claiming results already exist. Actual Pi instructions, effective tool declarations, tool-call arguments and tool-result contents are unchanged. Resume behavior is unchanged and is not certified by this acceptance.

## Verification

The fake-CLI regressions went from two failures to two passes. They assert identical system instructions and tool declarations, an unchanged earlier message prefix, preserved tool-call history, and successful use of the result. The real CLI also passed both transitions against a local synthetic SSE endpoint with dummy credentials. Comparisons ignore moving cache-control markers, not conversation content.

Live checks used the existing CLI login. No credentials were fetched, and no request headers or bodies were persisted. All requests returned HTTP 200, with exactly one upstream request per turn.

Text reply, then tool call, then the first tool result:

| Turn              | input | cacheRead | cacheWrite |
| ----------------- | ----: | --------: | ---------: |
| Text reply        |    10 |    11,272 |          0 |
| Tool call         |    10 |    11,308 |          0 |
| First tool result |    10 |    11,362 |          0 |

This run reused warmed cache entries. The first tool-result request read at least the preceding request's 11,308 cached tokens.

Tool call as the first reply, starting with a cold prefix:

| Turn              | input | cacheRead | cacheWrite |
| ----------------- | ----: | --------: | ---------: |
| Tool call         |    10 |         0 |     11,288 |
| First tool result |    10 |    11,288 |         54 |

The first tool-result request read all 11,288 tokens cached by the previous request. Both live runs also passed byte-prefix, system-prompt and inventory equality checks.

The initial live harness required a text response after the tool result and failed when the model made another tool call. That assertion was simplified to accept either successful response type. Acceptance concerns caching of the request carrying the result, not the model's next action. The tool-call transition, correct offered tool, one-request guard and measured cache assertions remain required.

## Repeat

```bash
# Deterministic provider regression with normalized Pi 1.x messages.
npx vitest run tests/first-tool-result-cache.test.ts

# Real CLI, local responses and dummy credentials.
npx vite-node scripts/acceptance/cache-prefix.ts --tool-result
npx vite-node scripts/acceptance/cache-prefix.ts --tool-first

# Existing CLI login, actual cache usage assertions.
npx vite-node scripts/acceptance/cache-prefix.ts --tool-result --live
npx vite-node scripts/acceptance/cache-prefix.ts --tool-first --live
```

Live acceptance checks `cacheRead[N+1] >= cacheRead[N] + cacheWrite[N]`. The script prints versions, usage counts and assertion outcomes only. Real instruction or inventory changes must still reach the model even when they invalidate the cache. These runs do not certify every model, CLI release, loadout, attachment shape or resume mode.
