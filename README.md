# pi-claude-subscription

A [Pi](https://github.com/earendil-works/pi) extension that routes LLM calls through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a subprocess. Use your Claude Pro/Max subscription as the LLM backend — no API key, no separate billing.

This is a fork of [rchern/pi-claude-cli](https://github.com/rchern/pi-claude-cli), renamed so it installs beside the original. Credit for the original design and implementation goes to its author. The MIT licence is kept (see [LICENSE](LICENSE)).

## How it works

The extension registers a custom pi provider, `pi-claude-subscription`. Each request spawns a `claude -p` subprocess using the stream-json wire protocol, and by default rebuilds the full Pi history into that one call (`replay`), so no CLI session state is needed. `resume` mode reuses the CLI's session with `--resume` instead. Claude proposes tool calls, pi executes them natively. Custom pi tools are exposed to Claude via a schema-only MCP server.

## Pi version support

This project targets **Pi 1.x only**, using `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`. Pi 0.52 and the legacy `@mariozechner/*` packages are no longer supported. We will not maintain a dual-version adapter or a 0.52 compatibility test suite. See [ADR-0001](docs/adr/0001-pi-1x-only-support.md) for the decision.

The minimum supported Pi version is **1.4.0**. The exact tested SDK pair is `@earendil-works/pi-ai@1.4.0` and `@earendil-works/pi-coding-agent@1.4.0`, pinned in development dependencies and the lockfile. Mandatory local-SDK tests cover startup model selection, registered text/tool requests, thinking mappings, API-key fallback, isolation and the one-request guard. CI runs the same suite on Node 22.19.0 across Linux, macOS and Windows. Local verification ran on Linux with Node 22.19.0 and 24.20.0; remote CI results are not implied. See [migration verification](docs/pi-1x-verification.md).

Host SDKs remain wildcard peers as required by Pi package loading. That metadata does not claim support for earlier releases, every later 1.x release or Pi-derived hosts. Complete provider correctness and native-provider parity are not certified by these checks. Known follow-ups are listed below.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude auth login`; `claude` on PATH)
- A Claude Pro or Max subscription
- [Pi 1.4.0 or later in the 1.x family](https://github.com/earendil-works/pi). Only SDK 1.4.0 is verified here; later versions require their own checks. Compatibility with GSD or other Pi-derived hosts is not implied.
- Node.js 22.19.0 or later.
- macOS or Linux. On Windows, use WSL.

## Setup

Install the supported host first, then install this checkout for the migrated code:

```bash
npm install -g @earendil-works/pi-coding-agent@1.4.0
npm ci
pi install .
```

Run `npm ci` from this repository. `pi install .` adds the local checkout to your personal Pi settings. The published `pi-claude-subscription@0.3.1` predates this migration; do not use it to verify the new SDK contract. No global Pi installation, real CLI or login is needed to run the tests.

Then select a model via `/model` in the interactive UI. Haiku, Sonnet, Opus and Fable are listed under the `pi-claude-subscription` provider.

It can be installed alongside `pi-claude-cli`: the provider ID, API name and temp file names differ.

## Settings

- Models come from the installed SDK's Anthropic catalog, with one latest entry per Haiku, Sonnet, Opus and Fable family. Catalog image limits, context/output limits and cost metadata are retained. Fable uses catalog metadata, not a synthetic alias.
- Thinking levels respect catalog exclusions. Existing mappings remain: minimal/low use CLI low; medium/high use medium/high outside Opus; non-Opus xhigh uses high. Opus medium uses high and high/xhigh use max. Explicit max uses max only for a catalog model declaring max support; unknown models cannot gain max through a family-name substring. Off, when supported, and an unspecified level omit the CLI effort flag, not a promise to disable CLI thinking. Custom token budgets remain unsupported and produce a warning. These mappings were exercised with the fake CLI, using the effort flag vocabulary inspected from Claude Code 2.1.312 help, not live reasoning-quality tests.
- The inactivity timeout is fixed at 180 seconds without CLI output.
- Request timeout: a request is stopped after 10 minutes by default. Set `PI_CLAUDE_SUBSCRIPTION_TIMEOUT_MS` to a number of milliseconds to change it (invalid or non-positive values use the default). It is read on every request. On timeout, or when Pi cancels, the whole CLI process tree is killed (process group on macOS/Linux), and the temp directory and relay port are released.
- API-key fallback: set `PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK=1` (also `true`) to send requests through pi's normal Anthropic provider, billed to `ANTHROPIC_API_KEY`, for example when subscription limits run out. Unset it or set it to `0` to return to the subscription path. It is read on every request, so nothing needs reinstalling.
- Session mode: `PI_CLAUDE_SUBSCRIPTION_SESSION_MODE=replay|resume`, default `replay`. `replay` sends the whole history, including tool calls and results, as one text block per message and leaves no CLI session state, so a session can finish in a fresh container. `resume` sends only the new turn and uses `--resume` on the CLI session files on disk. If the resumed session is missing or unreadable (the CLI exits with `No conversation found with session ID`), that turn falls back to `replay`, which leaves no session behind, so each later turn falls back again. It is read on every request.
- Environment precedence: a caller's provider-scoped `env` option overrides the process environment for that request only; empty scoped values fall through to the process value, as in pi-ai. It applies to the session mode, request timeout, API-key fallback flag and key, the relay's upstream (`ANTHROPIC_BASE_URL`) and the variables the CLI inherits. `process.env` is never changed. The CLI is still stripped of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_USE_*`, and the isolation variables, nonessential-traffic suppression and its loopback relay URL are always set last, so scoped values cannot override them. Supplying a key without `PI_CLAUDE_SUBSCRIPTION_API_KEY_FALLBACK` does not enable the fallback. The debug flag stays process-wide. The relay is Node's plain HTTP(S) client: proxy and custom TLS variables reach the CLI but are not applied to the relay's upstream connection, and only plain loopback upstreams are tested.
- Logging: default logs contain no tokens, prompts or tool arguments, and request headers are never logged. Set `PI_CLAUDE_SUBSCRIPTION_DEBUG=1` (also `true`) for fuller logs: one extra line per relay request; one `request diagnostics` JSON line per CLI request with a request id, the reason it ended, the extension, Pi and Claude CLI versions, whether message start, message stop and the CLI result were seen, the exit code or signal, cancellation and timeout, and the relay's upstream and rejected counts; and the content of unparseable CLI output lines and malformed control requests, which can include prompt text or tool arguments. Treat debug logs as sensitive.

## Known limits

- `resume` mode depends on CLI session files on the local disk, so it does not survive throwaway containers. Use `replay`.
- Images and documents are passed through, including documents in earlier turns, which are re-sent with each request and count against the context window every time, so large documents can push a long session over its limit. Images in earlier turns become a text placeholder. Other attachment types are rejected with an error in the latest user message and dropped with a warning in earlier turns.
- Effective normalized system-instruction forwarding remains [#40](https://github.com/markdlabrecque/pi-claude-subscription/issues/40). Workspace guidance remains [#43](https://github.com/markdlabrecque/pi-claude-subscription/issues/43).
- Current-request tool inventory and activation remain [#42](https://github.com/markdlabrecque/pi-claude-subscription/issues/42). The migration tests use a stable offered tool set, not changing or deferred inventories.
- Truthful terminal failure/cancellation statuses remain [#41](https://github.com/markdlabrecque/pi-claude-subscription/issues/41). Existing cleanup tests do not certify all terminal statuses.
- Broader extension compatibility remains [#14](https://github.com/markdlabrecque/pi-claude-subscription/issues/14), including provider-scoped environment [#50](https://github.com/markdlabrecque/pi-claude-subscription/issues/50) and third-party tools/attachments [#52](https://github.com/markdlabrecque/pi-claude-subscription/issues/52). Native-provider parity is not promised; see [Provider hooks](#provider-hooks) for what the CLI path does honor.
- Cache-write pricing remains [#34](https://github.com/markdlabrecque/pi-claude-subscription/issues/34), and account-side billing verification remains [#35](https://github.com/markdlabrecque/pi-claude-subscription/issues/35). Cache optimization is deferred until [#39](https://github.com/markdlabrecque/pi-claude-subscription/issues/39), #40 and #42 are complete.
- Native Windows is not supported. On Windows, use WSL.

## Provider hooks

Tested with `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` 1.4.0, the registered provider, a fake Claude CLI and a fake upstream. No real account requests were made. The API-key fallback uses Pi's own Anthropic provider and is unchanged.

| Pi hook                                           | CLI-path behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onPayload` / `before_provider_request`           | Called and awaited at the relay with the parsed JSON body of the one Messages request the CLI actually sends, and the model. In-place edits and a returned replacement are both forwarded, with Content-Length recomputed. A body that is not JSON or a hook that throws ends the request with an error, and cancelling while the hook is pending ends it as cancelled; neither forwards anything. Request headers, including authorization, are never passed to the hook. The CLI's later requests are refused before the hook.                                             |
| `onResponse` / `after_provider_response`          | Called and awaited with the status and headers of the one forwarded upstream response, success or error, before its body reaches the CLI. Not called when no HTTP response exists: a request refused locally, a CLI that fails to start or log in, the relay's local `HEAD` reply, or a rejected second generation. A hook that throws ends the turn with an error naming it, and the body is not delivered; cancelling while it is pending ends the request promptly.                                                                                                       |
| `onProviderStreamEvent` / `provider_stream_event` | Called and awaited, in arrival order, with each top-level `stream_event` the CLI prints on its NDJSON stdout, before Pi sees the normalized event. This is the CLI's parsed output, not a capture of the upstream SSE stream. Sub-agent events, malformed lines, control requests, `system` records and the CLI's result summary are not passed. Cancelling while the hook is pending ends the request without normalizing buffered output. A hook that throws stops the CLI and ends the turn with an error naming it; the failing event and later ones are not normalized. |

Edits made at the relay are not reflected in Pi's transcript or in Claude Code's own session history, so a `resume` turn continues from what the CLI recorded and a `replay` turn rebuilds from Pi's transcript. Prefer Pi's instruction, history and tool contracts, which apply before the CLI is started. Edits to generation parameters such as `max_tokens` and `temperature` are tested. Structural changes to tools, tool-call IDs, history, model or response format (for example dropping `stream`) can break the CLI's assumptions, and arbitrary edits are not promised to be safe. Other Pi commands, hooks, UI and header mutation are not claimed to work through this provider.

## Spike findings

Measured with `claude` 2.1.301 on a Pro/Max login (ticket #2). A local logging proxy on 127.0.0.1 was set as `ANTHROPIC_BASE_URL` and recorded every request body and header, with credential headers redacted. Planted markers: project and local `CLAUDE.md`, project and local settings hooks (`SessionStart`, `UserPromptSubmit`), a skill, a slash command, an agent, a `--plugin-dir` plugin skill and a `.mcp.json` server. The real user-level `CLAUDE.md`, skills, plugins and hooks served as user-level markers. With default flags every marker reached the upstream request and all hooks ran. With the recipe below none did. About 15 real requests were made, nearly all on Haiku.

### Host config flags

| Piece                                                                            | What turns it off                                             | Notes                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in tools                                                                   | `--tools ""`                                                  | Also removes Skill and Agent. MCP tools stay unless `--strict-mcp-config`. Pi's own `read`/`write`/`edit`/`bash`/`grep`/`find` must then be advertised through the schema-only MCP server too (they arrive as `mcp__custom-tools__<name>`). |
| User, project, local settings (hooks, env, permissions, agents, enabled plugins) | `--setting-sources ""`                                        | `--settings <file>` stays active (a hook in it ran) and so do `--plugin-dir`, `--plugin-url`, `--agents`. Never pass them. Admin-managed settings are documented as still applying; not testable here.                                      |
| CLAUDE.md, CLAUDE.local.md, user CLAUDE.md                                       | `--setting-sources ""` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | Each worked alone. Set both.                                                                                                                                                                                                                |
| Memory                                                                           | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`                           | Removes the memory instructions and the memory path. `--system-prompt` also drops the instructions.                                                                                                                                         |
| Skills, slash commands                                                           | `--disable-slash-commands`                                    | `--setting-sources ""` alone still lists bundled and built-in plugin skills.                                                                                                                                                                |
| Hooks                                                                            | `--setting-sources ""`                                        | 8 hook events in the default run, 0 with the flag.                                                                                                                                                                                          |
| Plugins                                                                          | `--setting-sources ""`                                        | Four built-in `cc-plugin-*` plugins still load. They add nothing to the request.                                                                                                                                                            |
| MCP servers (`.mcp.json`, claude.ai connectors, plugin MCP)                      | `--strict-mcp-config` plus our own `--mcp-config`             | Without it a default run offered 110+ connector tools.                                                                                                                                                                                      |
| System prompt                                                                    | `--system-prompt`                                             | Replaces the default prompt, not appended.                                                                                                                                                                                                  |
| Title side request                                                               | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (or `--name x`)  | See the relay note below.                                                                                                                                                                                                                   |

Unusable:

- `--bare` never reads the OAuth login (`Not logged in`).
- `--safe-mode` clears all host config in one flag but also drops `--mcp-config` servers, so Pi's tools disappear.

Still sent with the recipe, not removable:

- A first user-message `<system-reminder>` carrying the account email.
- A `system`-role message with the environment: cwd, platform, shell, OS version, date. That cwd is the CLI's private temp directory, not the project. Claude learns the workspace from Pi's own cwd section, forwarded in the system prompt, including under SDK embedding where the host process cwd differs. Pi's tools run in that workspace.
- The `x-anthropic-billing-header` and "You are a Claude agent, built on Anthropic's Claude Agent SDK." system blocks.

Recipe (zero tools, no markers upstream):

```
CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
  --model <alias> --tools "" --setting-sources "" --disable-slash-commands --strict-mcp-config \
  --mcp-config <schema-server config> --system-prompt <pi prompt> --no-session-persistence
```

### Replay encoding

Chosen: one `claude -p` call with `--input-format stream-json` and a single user message whose `content` is an array of text blocks, one per Pi history message, oldest first. Each block is `<turn role="user|assistant|tool">...</turn>`, with tool calls and results rendered as text inside the turn. A line in the system prompt says "reply as the assistant to the last user turn". A text-encoded transcript (tool call and result as text) made Haiku emit a real `tool_use` for the next file.

Why not the alternatives:

- **Separate stream-json lines (user, assistant, user):** each user line starts its own turn, so there were 2 main requests. The assistant line was moved before the first user message and the real `tool_result` was replaced by `[Tool result missing due to internal error]`.
- **A synthesized session file plus `--resume`:** writes state into `~/.claude`, which defeats stateless replay.
- **One text blob:** works, but loses prompt caching (see cost).
- **Plain `-p "<text>"`:** also works, but cannot carry images.

Keep each block's bytes stable between turns, and do not put a trailing instruction in the last block. Earlier blocks then hit the prompt cache.

### Base URL under subscription login

**Honoured.** `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (plain http on loopback) sends `POST /v1/messages?beta=true` to the proxy, with an `authorization` header and `anthropic-beta: oauth-2025-04-20,...`. Forwarding the first request to `https://api.anthropic.com` with the headers passed through untouched returned 200 and a real completion, for Haiku, Fable and image input. The relay design stands. Relay pitfalls:

- In stream-json input mode the CLI fires a second request concurrently: a Haiku "naming a coding session" call that carries the user's first prompt. It arrived first in every run, so "forward the first request" would forward the title call and reject the real one. Suppress it with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. It does not occur with plain `-p "<text>"`.
- The CLI also sends `HEAD /api/hello` to the base URL (not sent with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`). The relay must answer it.

### Attachments

**Pass through.** In a stream-json user message, `image` (base64) and `document` (text source) blocks reach the upstream request unchanged (base64 byte-identical). Haiku answered "Red, PELICAN" for a red PNG plus a document containing the word. Plain-text `-p` cannot carry them, so use the stream-json input path.

### Replay vs resume cost

Four-turn Haiku session with 2 MCP tools. Tokens per turn, input side (uncached + cache write + cache read):

| Mode                       | Per turn               | Total | Cache read |
| -------------------------- | ---------------------- | ----- | ---------- |
| `--resume`                 | 1031, 1078, 1352, 1634 | 5095  | 3062       |
| Replay, one text blob      | 1031, 1110, 1366, 1665 | 5172  | 686        |
| Replay, one block per turn | 1089, 1131, 1455, 1701 | 5376  | 2638       |

Counts are about equal, but a text blob re-bills the whole history as cache writes each turn. Weighting 1h cache writes 2x and cache reads 0.1x (API list ratios; subscription metering is unknown), the blob costs about 2.1x resume and per-turn blocks about 1.3x. The gap grows with history length. Output tokens varied from 233 to 2596 for the same prompt, so they are left out of the comparison.

Resume notes:

- A resumed session freezes its first system prompt. Pass `--system-prompt-snapshot off` or later prompt changes are ignored.
- A missing session exits 1 with `No conversation found with session ID: <id>` and sends no request, which is the signal for the replay fallback.
- `--resume` found the session from a different cwd.

### Fable

`--model fable` works. The alias resolves to `claude-fable-5-1`, and a real request on it returned 200. The full id `claude-fable-5-1` is accepted by the CLI as is. The other aliases resolve to `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`.

## Acceptance runs

Opt-in runs against the real `claude` CLI and a real subscription. They are not part of `npm test`. `scripts/acceptance/run.ts` drives `streamViaCli` the way Pi does (Haiku, two schema-only Pi tools, short prompts), runs the tools itself, and reads the relay's own per-request log lines. `scripts/acceptance/claude-spy.cjs` sits in front of the real CLI on PATH and records only the type of each CLI output message, so Claude Code tool executions (a `user` message with a `tool_result` block) can be counted. On the host the run uses a private `CLAUDE_CONFIG_DIR` with a symlink to the existing login, so the CLI's own state stays out of `~/.claude`.

Run on 2026-10-15, Linux, CLI 2.1.301, model `haiku`.

### 1. 50 consecutive tool-using turns

```
npx vite-node scripts/acceptance/run.ts turns 50
```

Result: pass. 50 tool-using turns (`step` x 41, `lookup` x 9; one tool call per turn) plus 1 final text turn. 51 upstream requests in total, exactly 1 per turn, all status 200. 0 requests rejected by the relay. 0 Claude Code tool executions in 578 CLI output messages. 0 stray CLI processes and 0 leftover temp dirs afterwards. 102 input and 2979 output tokens as reported by the CLI (the rest was cache). About 4.2 s per turn.

### 2. Cross-container replay

Build a throwaway image with the CLI installed the supported way, copy the repo (with `node_modules`) to a scratch dir, then run the two halves in separate containers. Each container is `--rm`, runs as uid 1000, gets a fresh tmpfs for `~/.claude`, and gets the host credentials file as a read-only bind mount. The two containers share only `/shared`, which holds the Pi message history.

```
printf 'FROM node:22-slim\nRUN npm i -g @anthropic-ai/claude-code@2.1.301\n' > Dockerfile
docker build -t pi-accept-claude:2.1.301 .
run() { docker run --rm --user 1000:1000 \
  --tmpfs /home/node/.claude:uid=1000,gid=1000 \
  -v "$HOME/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro" \
  -v "$APP:/app" -v "$SHARED:/shared" -w /app pi-accept-claude:2.1.301 \
  node_modules/.bin/vite-node scripts/acceptance/run.ts "$@"; }
run start /shared     # container A
run finish /shared    # container B, fresh
```

Result: pass.

- A: one request, Haiku called `lookup` for `alpha` and `beta`; Pi issued a random code per key and saved the history.
- B: a new container, `~/.claude` held only `.credentials.json` before its first request. Replay sent the history in one request; the answer contained the `alpha` code, which exists only in A's history. 1 upstream request, status 200, 0 rejected.
- The provider works inside the container. The CLI left only its own process registry files under `~/.claude/sessions` and a config backup, no `projects/` transcript.
- Read-only proof: in the container the bind mount shows as `ro`, `echo x >> .credentials.json` fails with `Read-only file system`, and `rm` fails with `Device or resource busy`. The host file's size and mtime (1032 bytes, 13:34:38) were identical before and after. The file was never read or copied.

### 3. Test suite

On Linux (`Linux 7.2.5`, Node 24): `npm test` 19 files, 320 tests passed; `npm run lint` clean; `npm run typecheck` clean; `npm run format:check` clean.

On macOS (`Darwin 27.0.0`, Node v24.21.0): `npm test` 19 files, 328 tests passed; `npm run lint` clean; `npm run typecheck` clean; `npm run format:check` clean.

## License

MIT. Copyright (c) 2026 Rebecca Chernoff (upstream author); see [LICENSE](LICENSE).
