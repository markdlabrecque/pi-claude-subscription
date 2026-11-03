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

**Live re-verification: pending.** The `--live` check has not been rerun against the second shape, so live correctness of this fix is not established. The maintainer deferred live proof for this delivery to [issue #89](https://github.com/markdlabrecque/pi-claude-subscription/issues/89). That issue owns the manual procedure and evidence, including two known limits of the current script: it hardcodes `claude-haiku-4-5`, which may not produce the second shape, and its exact-prefix byte check compares only `messages[0]`, so an unnormalized cwd in a later message would be caught only by the cache-read assertion. When the check is run, record the CLI version, model, date, observed reminder shape and per-turn cache reads and writes here.

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
