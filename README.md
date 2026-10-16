# pi-claude-subscription

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that routes LLM calls through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a subprocess. Use your Claude Pro/Max subscription as the LLM backend — no API key, no separate billing.

This is a fork of [rchern/pi-claude-cli](https://github.com/rchern/pi-claude-cli), renamed so it installs beside the original. Credit for the original design and implementation goes to its author. The MIT licence is kept (see [LICENSE](LICENSE)).

## How it works

The extension registers a custom pi provider, `pi-claude-subscription`. Each request spawns a `claude -p` subprocess using the stream-json wire protocol, with `--resume` on follow-up turns to reuse the CLI's session state instead of replaying full history. Claude proposes tool calls, pi executes them natively. Custom pi tools are exposed to Claude via a schema-only MCP server.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude auth login`; `claude` on PATH)
- A Claude Pro or Max subscription
- [pi](https://github.com/mariozechner/pi-coding-agent) or [GSD](https://github.com/gsd-build/gsd-2)
- macOS or Linux. On Windows, use WSL.

## Setup

Add to `~/.gsd/agent/settings.json`:

```json
{
  "packages": ["npm:pi-claude-subscription"]
}
```

Then select a model via `/model` in the interactive UI. Haiku, Sonnet, Opus and Fable are listed under the `pi-claude-subscription` provider.

It can be installed alongside `pi-claude-cli`: the provider ID, API name and temp file names differ.

## Settings

- Thinking effort follows pi's thinking level (low, medium, high, max). Opus models use an elevated mapping.
- The inactivity timeout is fixed at 180 seconds without CLI output.

## Known limits

- One pi turn can still trigger more than one request to Anthropic. The CLI sometimes attempts extra generations.
- Claude Code settings on the host (CLAUDE.md, memory, skills, hooks, plugins) may leak into requests.
- `--resume` depends on CLI session files on the local disk, so it does not survive throwaway containers.
- A tool call for a tool that was not offered can fail the turn.
- Native Windows is not supported. On Windows, use WSL.

## License

MIT. Copyright (c) 2026 Rebecca Chernoff (upstream author); see [LICENSE](LICENSE).
