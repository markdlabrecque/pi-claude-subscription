## Agent skills

### Issue tracker

Issues live in GitHub Issues on `markdlabrecque/pi-claude-subscription` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## GitHub access

SSH authenticates as `marklabrecque-ab`, which cannot push to this repo. Use the `gh` login `markdlabrecque` instead. Push over HTTPS with the `gh` credential helper:

```
git -c credential.helper='!gh auth git-credential' push https://github.com/markdlabrecque/pi-claude-subscription.git <branch>
```

Always pass `-R markdlabrecque/pi-claude-subscription` to `gh pr` / `gh issue`, since the repo is a fork and `gh` may default to upstream `rchern/pi-claude-cli`.
