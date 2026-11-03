# Live acceptance on the Pi 1.x stack

Harness and evidence rules for [issue #79](https://github.com/markdlabrecque/pi-claude-subscription/issues/79). **No live run has been authorized or executed for this work.** Every cell of the matrix is untested; see [the generated notes](acceptance/notes.md). Nothing here claims fresh evidence.

## Rules

- Live runs are local only. `scripts/acceptance/run.ts` refuses to start when `CI`, `GITHUB_ACTIONS` or another CI marker is set. CI runs only the offline tests in `tests/acceptance-evidence.test.ts`.
- Every invocation needs an explicit approval file passed with `--approval`. There is no default and no auto-approval. The approval must name the run's host, model and scenario, set request, token and time limits, and list stop conditions. Otherwise the harness refuses before it spawns the CLI or touches credentials.
- The harness writes the approved scope, limits and stop conditions to the run record before the first request.
- API fallback stays off. The harness calls the CLI path directly.
- Model ids are matched exactly against the models the extension registers from the installed Pi SDK. A missing model exits with `UNTESTED` and status 3, without sending a request. No other model is substituted.
- The harness never reads, copies or changes account credentials or spending settings. Records keep no credentials, environment, prompts, messages or model output.

## Matrix

Hosts `darwin` (macOS) and `linux` × models `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-1` × the three scenarios below. No third-party extension or personal workflow is part of the matrix, and passing it does not show compatibility with arbitrary extensions.

## Scenarios and expected outcomes

The assertions live in `evaluateScenario` in `scripts/acceptance/evidence.ts`. Each scenario has a fixture id. Bump it when the prompts or tools change, so older runs stop counting as comparable.

| Scenario                  | Fixture         | Passes only when                                                                                                                                                                                                                                                                                                   |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool-turns-50`           | `turns-v1`      | Exactly 50 tool-using turns, each with one upstream request. No relay rejections and no Claude Code tool executions. A final text turn makes one request and says "finished".                                                                                                                                      |
| `compaction-continuation` | `compaction-v1` | Pi issues one random code per `lookup` key. Pi's own `generateSummaryWithUsage` summarizes the history, and the summarized messages are dropped. The next answer, given only the compaction summary, contains every issued code.                                                                                   |
| `fresh-container-replay`  | `replay-v1`     | Container A makes one request and Pi issues the codes. Container B is fresh: `~/.claude` holds only `.credentials.json` before its first request. It replays the history and answers with the `alpha` code, which exists only in A's history. Every turn makes one upstream request and the relay rejects nothing. |

## Approval file

A maintainer writes one file per approved run or campaign. The `ref` becomes the campaign id in every record made under it.

```json
{
  "ref": "issue-79#approval-1",
  "approvedBy": "maintainer",
  "scope": {
    "hosts": ["linux"],
    "models": ["claude-haiku-5-5"],
    "scenarios": ["tool-turns-50"]
  },
  "limits": { "maxRequests": 60, "maxTokens": 200000, "maxSeconds": 1800 },
  "stopConditions": ["first failed scenario", "any non-200 upstream status"]
}
```

Limits apply to each invocation. The two phases of `fresh-container-replay` share one budget, because the finish phase starts from the start phase's usage. Tokens count input, output, cache-read and cache-write tokens. The `stopConditions` text is recorded as approved. Whatever it says, the harness always stops on the following:

- `maxRequests` or `maxTokens` reached before the next request
- `maxSeconds` reached: the in-flight request is aborted and the cancellation is recorded
- SIGINT: also aborts the in-flight request and is recorded as a cancellation
- any non-200 upstream status
- any relay rejection of an extra request

A stopped run is recorded as failed, with the reason.

## Running

From the repo root, on the host, with the Claude CLI already logged in:

```bash
npx vite-node scripts/acceptance/run.ts tool-turns-50 \
  --approval approval.json --model claude-haiku-5-5 --records docs/acceptance/records
npx vite-node scripts/acceptance/run.ts compaction-continuation \
  --approval approval.json --model claude-haiku-5-5 --records docs/acceptance/records
```

`fresh-container-replay` runs in two containers set up as in the README's historical cross-container run. Mount the approval file and pass `--host` with the platform of the machine running the containers, because a container always reports Linux:

```bash
run() { docker run --rm --user 1000:1000 \
  --tmpfs /home/node/.claude:uid=1000,gid=1000 \
  -v "$HOME/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro" \
  -v "$APP:/app" -v "$SHARED:/shared" -w /app pi-accept-claude \
  node_modules/.bin/vite-node scripts/acceptance/run.ts fresh-container-replay \
  --approval /shared/approval.json --model claude-haiku-5-5 \
  --records /shared/records --shared /shared --host linux "$@"; }
run --phase start    # container A
run --phase finish   # container B, fresh
```

Copy `$SHARED/records/*.json` into `docs/acceptance/records/` afterwards.

Exit status: 0 passed, 1 failed, 2 refused or harness error, 3 model untested.

## Run records

Each run writes `<records>/<runId>.json`, built through the allow-list in `buildRunRecord`. Fields:

- `host`: platform, arch, kernel release, and whether the run was in a container
- `versions`: Node, Pi AI, Pi coding agent, Claude CLI, extension
- `model`: requested and resolved id
- `scenario`: id and fixture id
- `config`: session mode and API fallback
- approval: `approvalRef`, plus the approved scope, limits and stop conditions
- result: `outcome`, `reasons`, `stoppedBy`, `durationMs`
- `usage`: requests, input, output, cache-read and cache-write tokens
- `cancellation`: whether one was triggered, its trigger, and whether cleanup was clean
- `cleanup`: stray CLI processes, leftover temp entries, and whether the host credentials file was unchanged

A record is written before the first request, with outcome `failed` and `stoppedBy: "incomplete"`. A run that dies part way therefore still shows as failed.

## Regenerating the notes

```bash
npx vite-node scripts/acceptance/notes.ts
```

This reads `docs/acceptance/records/*.json` and `docs/acceptance/target.json`, then rewrites [`docs/acceptance/notes.md`](acceptance/notes.md). It is offline: it sends no request and reads no credentials. `--out -` prints the notes instead of writing the file.

`target.json` names the campaign whose runs count as fresh (`null` until one is approved), plus the versions and configuration that evidence must match. Its Claude CLI version, 2.1.316, is the last one verified in this repo ([cache verification](first-tool-result-cache-verification.md)). Update the file when a campaign is approved. Node is recorded but not compared, because the two hosts run different Node builds.

Each host × model × scenario cell is filled only by a run of that exact host, model and scenario. A pass elsewhere never fills a cell.

- **Fresh**: from the target campaign, with matching versions, configuration and fixture.
- **Reused**: matching, but from an earlier campaign.
- **Historical**: some version, configuration or fixture differs. The notes list each differing key, and these runs do not count as acceptance.
- **Untested**: no run record.

Within a class, a failed run outweighs a passed one, so a failure stays visible.

The README's 2026-10-15 runs (CLI 2.1.301, alias `haiku`, before the Pi 1.x migration) have no structured records. They stay historical prose and fill no cell.
