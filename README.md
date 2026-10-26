# daybook

A small daily notes app for the things you need to work on. You write markdown and it renders as you type.

- Each day gets its own page, plus one Backlog page for later
- `[ ] ` or `- [ ] ` starts a task list
- Paste a GitHub PR or issue link and it becomes a chip with the title and a live status color (open, draft, merged, closed). Titles come from your `gh` login, so private repos work too
- Paste a Slack message link and it shows the four-color Slack underline. Click any link to open it
- Linear issue links show their title and status (triage, backlog, todo, in progress, done, canceled) once you add an API key in Settings (`⌘,`). The key is stored in your Keychain
- `⌘K` captures a task from anywhere in the app. `tab` switches between Today and Backlog
- When today is empty, it offers to bring over the most recent day's unfinished tasks

## Run

```sh
pnpm install
pnpm app:build  # builds src-tauri/target/release/bundle/macos/Daybook.app
pnpm app        # the Mac app in dev mode, with hot reload
pnpm dev        # the same UI in a browser at http://localhost:4321
```

To update the installed app, run `pnpm app:build` and copy `Daybook.app` into `/Applications`. Building needs Rust (`rustup`).

Closing the window hides it, and clicking the Dock icon brings it back. `⌘Q` saves any pending edit before it quits.

Notes are saved as plain markdown in `~/Daybook/YYYY-MM-DD.md` (plus `backlog.md`). Set `DAYBOOK_DIR` to use a different folder.

## Agents and the command line

The app binary is also a `daybook` command. Settings → Agents → Install links it at `~/.local/bin/daybook`. Agents like Claude Code can run `daybook help` to learn it:

```sh
daybook add Review https://github.com/acme/api/pull/42     # to today
daybook add Plan the offsite --backlog
daybook tasks --open
daybook done 2                                              # or: daybook done auth fix
daybook days
```

The app watches `~/Daybook`. When the CLI, an agent or another editor changes a note, the app shows the change straight away. If you're typing in that note at the same time, both sets of edits are merged.

## Keys

| | |
|---|---|
| `⌘K` | capture |
| `⌥↑` / `⌥↓` | previous / next day |
| `⌘/` | toggle markdown source |
| `⌘\` | toggle sidebar |
| `⌘,` | settings |
