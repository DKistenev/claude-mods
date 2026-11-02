# jj-diff

A read-only pane beside the Claude Code chat that shows the diff of a [Jujutsu](https://jj-vcs.github.io/jj/) (jj) repository. It works in secondary jj workspaces that have a `.jj` folder but no `.git`, where the built-in diff view and git-based diff mods show nothing.

## Install

At the prompt of a terminal session:

```
/plugin install jj-diff --marketplace DKistenev/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope. A mod installed at the user scope from a terminal also loads in the local session the desktop app starts for its Code tab, and draws there.

In the desktop app itself, where `/plugin` does not run: click `+` next to the prompt box, then Plugins, Add marketplace with `DKistenev/claude-mods`, then Add plugin.

`jj` must be on the PATH of the session.

## Usage

```
/jj-diff                      current change:        jj diff --git -r @
/jj-diff cl                   whole stack to review: jj diff --git --from 'trunk()' --to @
/jj-diff rev <change-id>      one change:            jj diff --git -r <change-id>
/jj-diff [mode] <path>        pin the pane to the jj repo or workspace at <path>
/jj-diff close                close the pane
```

The pane shows the file list with `+`/`-` counts and the hunks in diff colors. Click a file row to collapse or expand it. The header has `change` and `cl` buttons to switch mode (hotkeys `c` and `l` while the pane has the keyboard) and a `Refresh` button (`r`).

### Which repository

1. A path given to `/jj-diff` wins and is shown as `(pinned)`. A later `/jj-diff` without a path unpins.
2. Otherwise the pane follows the files Claude edits: after every `Edit`, `Write` or `NotebookEdit` it runs `jj root` in the edited file's directory and switches to that repository, shown as `(followed)`. This is how a secondary workspace is found: `jj root` answers inside any jj workspace, `.git` or not.
3. Otherwise the session's working directory.

If none of these is a jj repo, the pane says `Not a jj repo: <dir>`.

### When it refreshes

After every `Edit`, `Write`, `NotebookEdit` and `Bash` tool call finishes, and on the `Refresh` button. Nothing is polled on a timer. The refresh runs inside the tool call's hook, so Claude's next step waits for `jj diff` to finish (typically well under a second); a diff that takes longer than 60 s is given up and reported in the pane.

### What it runs

Only reads: `jj root` and `jj diff --git`, both with `--no-pager --color never --quiet`. The mod never runs `jj new`, `jj describe`, `jj squash` or any other command that changes the repository.

One consequence to know: like any `jj` command, `jj diff` snapshots the working copy first, which records a "snapshot working copy" operation in the op log and updates the working-copy commit's content. That is the normal jj model, not a change the mod makes on its own, and it is deliberate: the pane is meant to show the current working copy, including the edits Claude just made. `--ignore-working-copy` was considered and not used, because with it the pane would show the last snapshot some other jj command took, so Claude's edits would be missing until you ran `jj` yourself. Because the refresh runs only after a tool call has finished, it never snapshots a half-written file.

Large diffs: the pane draws at most 400 lines per file and 3000 lines in all, and says how many lines it left out. Output past 4 MiB is cut.

## Tests

```bash
claude plugin validate plugins/jj-diff
claude plugin test plugins/jj-diff
```

The tests drive the real hooks module through a fake engine whose `$.process.run` answers `jj root` and `jj diff` from a table, so they run without jj: mode to command mapping, repo resolution for a workspace without `.git`, the pinned path, the not-a-jj-repo message, diff parsing with counts, and the refresh after an Edit, a Bash call and the button.

The same command list and parser were also checked against jj 0.45.1 on a throwaway `jj git init` repo with a `jj workspace add` secondary workspace: `jj root` answers in the workspace without `.git`, and the three modes parse into the expected files and counts.
