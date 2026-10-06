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

`/ci`, or the `▸` button, opens every workflow with every job named, and closes it again. `/ci` also refreshes at once. Where the terminal does not pass clicks on (outside fullscreen), the line ends with the hint `/ci to expand`.

## Install

Needs the `gh` CLI, signed in, and a GitHub remote.

```
/plugin install ci-line --marketplace Halvanhelv/claude-ci-line
```

## Refresh

- every 15 seconds while a workflow is queued or running, and for 3 minutes after a commit or push while its runs have yet to appear
- every 2 minutes otherwise
- on the next tick after the branch, HEAD or the upstream ref changes
- 5 seconds after a `git push` or a `gh pr|run|workflow` command run through Bash

With no `gh`, no network or nothing reported on the commit the band stays empty; a failed read keeps the last line.

## Not shown

Review state, checks a branch protection requires that never reported, and runs on other branches (a deploy after merge).

## Develop

```
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```
