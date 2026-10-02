# Claude Code mods

## plan-progress

Live progress bars above the Claude Code prompt. Claude breaks medium and large tasks into stages and steps, and you watch them fill in real time.

- One thin row per task: state, title, pixel bar, percent, close button
- A pill on the bar shows the current stage and step count
- Stage boundaries are full-height lines, steps are short ticks
- Several bars at once, aligned, no layout shifts
- Soft sounds when Claude needs a decision, hits an error or finishes
- A **Progress** button in the footer hides and shows the bars

### Install

In Claude Code:

```
/plugin marketplace add zycck/claude-mods
/plugin install plan-progress@zycck-mods
```

Or copy `plugins/plan-progress` into `~/.claude/skills/plan-progress` to load it in every session.

### Commands

- `/progress` toggles the bars
- `/progress-demo` shows a demo bar
- `/progress-sounds` plays the three sounds
- `/progress-clear` removes all bars

### How it works

The mod registers a `plan_progress` tool. Claude creates a bar once with the full breakdown, then sends short updates such as `{id, next: true}`. A light gate asks Claude to create a bar before a task with several edits, and reminds it when a bar goes stale.

Built with Claude Code mods (function hooks). The bar looks best in the desktop app; the terminal gets a text bar.

## License

MIT
