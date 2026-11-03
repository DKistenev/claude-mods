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

Click **jj diff** in the footer under the prompt to open the pane; click it again to close it. There is no slash command.

The pane always shows the whole stack going to review: `jj diff --git -r 'trunk()..@'`, every change between `trunk()` and `@`. With one change per workspace that is exactly the CL; it also stays right after `jj new`, when `@` is empty and the work sits in `@-`.

It is laid out like the built-in diff pane: a header with the file count and `+`/`-` totals and a refresh button `↻`, then each file's name row with its counts over its hunks, drawn by the engine's own diff renderer (`Code` with `format: 'diff'`), so colors and gutters match the built-in. Click a file's name to collapse or expand it. The pane draws up to 90,000 characters of hunks; files past that say so.

### Which repository

1. The jj repo or workspace of the file Claude edited last: after every `Edit`, `Write` or `NotebookEdit` the pane runs `jj root` in that file's directory and switches there. `jj root` answers inside any jj workspace, `.git` or not.
2. Before any edit, the session's working directory if it is in a jj repo.
3. Otherwise the jj repos one level down (folders holding `.jj`), the first by name.

When the pane knows more than one repo, a `repo` picker in the header switches between them. With none, the pane says it waits for the next file Claude edits in a jj repo.

### When it refreshes

After every `Edit`, `Write`, `NotebookEdit` and `Bash` tool call finishes, and on the refresh button `↻`. Nothing is polled on a timer. The refresh runs inside the tool call's hook, so Claude's next step waits for `jj diff` to finish (typically well under a second). To keep a stuck jj (a lock held by another jj command, say) from stalling Claude, that in-hook refresh gives `jj root` 5 s and `jj diff` 8 s; opening the pane and the refresh button allow 15 s and 60 s. A timeout is reported in the pane, and the next tool call or button press tries again.

`jj root` is run once per directory and remembered for the session; a failing `jj diff` in that repository forgets it, so a moved or deleted workspace is looked up again.

### What it runs

Only reads: `jj root` and `jj diff --git`, both with `--no-pager --color never --quiet`. The mod never runs `jj new`, `jj describe`, `jj squash` or any other command that changes the repository.

One consequence to know: like any `jj` command, `jj diff` snapshots the working copy first, which records a "snapshot working copy" operation in the op log and updates the working-copy commit's content. That is the normal jj model, not a change the mod makes on its own, and it is deliberate: the pane is meant to show the current working copy, including the edits Claude just made. `--ignore-working-copy` was considered and not used, because with it the pane would show the last snapshot some other jj command took, so Claude's edits would be missing until you ran `jj` yourself. Because the refresh runs only after a tool call has finished, it never snapshots a half-written file.

Large diffs: the pane draws at most 400 lines per file and 3000 lines in all, and says how many lines it left out. Output past 4 MiB is cut.

## Tests

```bash
claude plugin validate plugins/jj-diff
claude plugin test plugins/jj-diff
```

The tests drive the real hooks module through a fake engine whose `$.process.run` answers `jj root` and `jj diff` from a table, so they run without jj: the footer button opening and closing the pane, the stack command, repo resolution for a workspace without `.git`, the jj repos found one level down and the `repo` picker, the no-repo message, diff parsing with counts, and the refresh after an Edit, a Bash call and the button.

The same command list and parser were also checked against jj 0.45.1 on a throwaway `jj git init` repo with a `jj workspace add` secondary workspace: `jj root` answers in the workspace without `.git`, and the diffs parse into the expected files and counts.
