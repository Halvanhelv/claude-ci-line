# ci-line

A Claude Code mod that shows the CI state of the current branch in the band above the prompt.

All green is one line, one checkpoint per workflow of the latest pushed commit:

```
CI d258227  ● Gate ── ● Code Review ── ● Validate ▸
```

A workflow that is running or has failed branches into its jobs, grouped by the `group / job` prefix:

```
CI d258227 ≠HEAD  ● Gate ── ● Code Review ── ✗ Validate ▾
                                             ├─ lint ● ● ✗ brakeman ●
                                             └─ test ◐ minitest ●
```

| Glyph | Meaning |
| --- | --- |
| `●` | success |
| `✗` | failed |
| `◐` | running |
| `○` | queued |
| `⊘` | cancelled |
| `◌` | skipped |

Commit statuses and check runs from outside Actions follow the workflows as checkpoints of their own.

`≠HEAD` means the local HEAD is not the commit CI ran on (not pushed yet).

`/ci`, or the `▸` button, opens every workflow with every job named, and closes it again. `/ci` also refreshes at once.

## Install

Needs the `gh` CLI, signed in, and a GitHub remote.

```
/plugin install ci-line --marketplace Halvanhelv/claude-ci-line
```

## Refresh

- every 15 seconds while a run is queued or running, every 2 minutes otherwise
- on the next tick after the branch or HEAD changes
- 5 seconds after a `git push` or a `gh pr|run|workflow` command run through Bash

With no `gh`, no network or no runs the band stays empty.

## Develop

```
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```
