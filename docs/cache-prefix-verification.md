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

Normalize only the private cwd value in the first CLI-generated environment reminder before forwarding the request and before the caller's `onPayload` hook. Do not reuse a working directory or remove instructions. The actual subprocess isolation, Pi's complete current instructions, workspace guidance, history and tool inventory remain unchanged.

The first live run after the fix reported `input: 10` on every turn:

- Turn 1: `cacheRead: 0`, `cacheWrite: 10533`.
- Turn 2: `cacheRead: 10533`, `cacheWrite: 22`.
- Turn 3: `cacheRead: 10555`, `cacheWrite: 22`.

Thus both follow-ups read the full previous cached prefix. A subsequent run reused the cache, reading 10533, 10555 and 10577 tokens with zero writes. Every turn forwarded exactly one request and received HTTP 200. Neither headers nor request bodies were written to disk or logs.

## Repeat

```bash
# Real CLI, dummy login, local synthetic SSE responses. Checks prefix bytes.
npx vite-node scripts/acceptance/cache-prefix.ts

# Real CLI and existing subscription login. Also checks measured cache reads.
npx vite-node scripts/acceptance/cache-prefix.ts --live

npm test
npm run typecheck
npm run lint
```

The byte comparison excludes cache-control markers because their placement moves with the final history block. The live assertion checks `cacheRead[N+1] >= cacheRead[N] + cacheWrite[N]` for each consecutive turn. The script prints versions and token counts, not request contents. Automated regressions also cover Windows-style paths, preserving Pi content and other reminder text, fresh subprocess directories, and caller payload-hook replacement.

These measurements cover text-only replay with an unchanged system prompt and empty tool inventory. They do not certify resume, all models, tool-result caching from issue #33, changing loadouts, date rollover or every CLI release. Real instruction or tool changes must continue to reach the model even when they invalidate the cache. The narrow reminder matcher must be rechecked when the CLI's generated format changes.
