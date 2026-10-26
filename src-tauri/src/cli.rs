//! `daybook` on the command line, for you and for agents. Same binary as the app.

use crate::notes::{self, NoteFile, Task};
use serde::Serialize;
use std::io::Write;
use std::path::Path;

const HELP: &str = "\
daybook: the command line for Daybook, a daily notes and tasks app.

Notes are markdown files in ~/Daybook (or $DAYBOOK_DIR; see `daybook path`):
one YYYY-MM-DD.md per day plus backlog.md. Tasks are GFM task lines
(\"- [ ] text\" open, \"- [x] text\" done), nested with 2-space indents.
\"- [>] text\" is a task the app moved to a later day.
The app may be open; it picks up file edits, but prefer `daybook add` and
`daybook done` over editing the files yourself: they keep the format right.

Commands:
  daybook show [when]
      Print the note's raw markdown. Prints nothing if the note is empty.
      e.g. daybook show yesterday
  daybook add <text...> [--backlog | --to <when>]
      Add an open task to the note (default today). Quotes are optional.
      e.g. daybook add Review https://github.com/acme/api/pull/42
  daybook tasks [when] [--open] [--json]
      Numbered list of the note's tasks. --open hides done and moved tasks but
      keeps the numbers. --json prints
      [{\"number\", \"done\", \"moved\", \"depth\", \"text\"}].
      e.g. daybook tasks --open
  daybook done <number | text...> [--in <when>]
      Tick one task: by its number from `daybook tasks`, or by a piece of its
      text (case-insensitive) that matches exactly one task.
      e.g. daybook done 2        daybook done auth fix --in yesterday
  daybook undo <number | text...> [--in <when>]
      Untick one task, matched the same way. Both work on moved tasks too.
  daybook days [--json]
      Every note, newest day first, backlog last, with open/done counts.
  daybook path
      Print the notes folder.

<when> is today (the default), yesterday, tomorrow, backlog, or YYYY-MM-DD.
--backlog is short for --to backlog / --in backlog.

Links: paste URLs bare (https://...), not as markdown links. The app turns
GitHub PR/issue, Linear and Slack links into titled chips on its own.

Task numbers are positions in the note, so run `daybook tasks` again before
`done` if the note may have changed.

Results go to stdout, errors to stderr. Exit codes: 0 ok, 1 failed (no
matching task, more than one, I/O error), 2 usage error.
";

#[derive(Debug)]
enum Fail {
    Usage(String),
    Error(String),
}

fn usage(msg: impl Into<String>) -> Fail {
    Fail::Usage(msg.into())
}

/// Runs the CLI when the binary was invoked with a subcommand; returns the exit code.
/// Returns None when the app should start normally.
pub fn run(args: &[String]) -> Option<i32> {
    let (cmd, rest) = args.split_first()?;
    if cmd.starts_with("-psn") {
        return None;
    }
    Some(match execute(cmd, rest, &notes::dir()) {
        Ok(out) => {
            let _ = std::io::stdout().write_all(out.as_bytes());
            0
        }
        Err(Fail::Usage(msg)) => {
            eprintln!("daybook: {msg}\nRun `daybook help` for usage.");
            2
        }
        Err(Fail::Error(msg)) => {
            eprintln!("daybook: {msg}");
            1
        }
    })
}

/// Runs one command against `dir` and returns what it prints on stdout.
fn execute(cmd: &str, rest: &[String], dir: &Path) -> Result<String, Fail> {
    let known = ["help", "--help", "-h", "show", "add", "tasks", "done", "undo", "days", "path"];
    if !known.contains(&cmd) {
        return Err(usage(format!("unknown command `{cmd}`")));
    }
    let wants_help = rest.iter().take_while(|a| *a != "--").any(|a| a == "--help" || a == "-h");
    if wants_help || matches!(cmd, "help" | "--help" | "-h") {
        return Ok(HELP.to_string());
    }
    match cmd {
        "show" => show(dir, rest),
        "add" => add(dir, rest),
        "tasks" => list_tasks(dir, rest),
        "done" => tick(dir, rest, true),
        "undo" => tick(dir, rest, false),
        "days" => days(dir, rest),
        _ => path(dir, rest),
    }
}

#[derive(Default)]
struct Parsed {
    words: Vec<String>,
    switches: Vec<String>,
    options: Vec<(String, String)>,
}

impl Parsed {
    fn has(&self, switch: &str) -> bool {
        self.switches.iter().any(|s| s == switch)
    }

    fn value(&self, option: &str) -> Option<&str> {
        self.options.iter().rev().find(|(name, _)| name == option).map(|(_, v)| v.as_str())
    }
}

/// Splits args into words and `--flags`. `--` ends the flags; unknown flags are usage errors.
fn parse(cmd: &str, args: &[String], switches: &[&str], options: &[&str]) -> Result<Parsed, Fail> {
    let mut parsed = Parsed::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--" {
            parsed.words.extend(iter.cloned());
            break;
        }
        if !arg.starts_with("--") {
            parsed.words.push(arg.clone());
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (arg.as_str(), None),
        };
        if switches.contains(&name) {
            if inline.is_some() {
                return Err(usage(format!("{name} takes no value")));
            }
            parsed.switches.push(name.to_string());
        } else if options.contains(&name) {
            let value = inline.or_else(|| iter.next().cloned()).ok_or_else(|| usage(format!("{name} needs a value")))?;
            parsed.options.push((name.to_string(), value));
        } else {
            return Err(usage(format!("unknown option {name} for `daybook {cmd}`")));
        }
    }
    Ok(parsed)
}

struct Note {
    id: String,
    label: String,
}

fn when(word: &str) -> Result<Note, Fail> {
    let id = match word.to_ascii_lowercase().as_str() {
        "today" => notes::day_id(0),
        "yesterday" => notes::day_id(-1),
        "tomorrow" => notes::day_id(1),
        "backlog" => notes::BACKLOG.to_string(),
        other => chrono::NaiveDate::parse_from_str(other, "%Y-%m-%d")
            .map(|d| d.format("%Y-%m-%d").to_string())
            .map_err(|_| usage(format!("unknown day `{word}`: use today, yesterday, tomorrow, backlog or YYYY-MM-DD")))?,
    };
    Ok(Note { label: label(&id), id })
}

/// "Today", "Yesterday", "Tomorrow", "Backlog", or the id itself.
fn label(id: &str) -> String {
    if id == notes::BACKLOG {
        return "Backlog".into();
    }
    for (offset, name) in [(0, "Today"), (-1, "Yesterday"), (1, "Tomorrow")] {
        if id == notes::day_id(offset) {
            return name.into();
        }
    }
    id.to_string()
}

/// The note named by an optional single positional `when`.
fn one_when(words: &[String]) -> Result<Note, Fail> {
    match words {
        [] => when("today"),
        [word] => when(word),
        _ => Err(usage(format!("expected one day, got `{}`", words.join(" ")))),
    }
}

/// The note named by `--backlog` or a `--to`/`--in` option, defaulting to today.
fn target(parsed: &Parsed, option: &str) -> Result<Note, Fail> {
    match (parsed.has("--backlog"), parsed.value(option)) {
        (true, Some(_)) => Err(usage(format!("use --backlog or {option}, not both"))),
        (true, None) => when("backlog"),
        (false, Some(word)) => when(word),
        (false, None) => when("today"),
    }
}

fn read(dir: &Path, id: &str) -> Result<String, Fail> {
    notes::read(dir, id).map_err(Fail::Error)
}

fn write(dir: &Path, id: &str, content: &str) -> Result<(), Fail> {
    std::fs::create_dir_all(dir).map_err(|e| Fail::Error(format!("can't create {}: {e}", dir.display())))?;
    notes::write(dir, id, content).map(|_| ()).map_err(Fail::Error)
}

fn show(dir: &Path, rest: &[String]) -> Result<String, Fail> {
    let note = one_when(&parse("show", rest, &[], &[])?.words)?;
    let markdown = read(dir, &note.id)?;
    Ok(match markdown {
        md if md.trim().is_empty() => String::new(),
        md if md.ends_with('\n') => md,
        md => md + "\n",
    })
}

fn add(dir: &Path, rest: &[String]) -> Result<String, Fail> {
    let parsed = parse("add", rest, &["--backlog"], &["--to"])?;
    let note = target(&parsed, "--to")?;
    let text = parsed.words.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(usage("nothing to add: daybook add <text>"));
    }
    let markdown = read(dir, &note.id)?;
    write(dir, &note.id, &notes::append_task(&markdown, &text))?;
    Ok(format!("Added to {}: {text}\n", note.label))
}

fn task_line(task: &Task) -> String {
    let mark = if task.done {
        "x"
    } else if task.moved {
        ">"
    } else {
        " "
    };
    format!("{}{:>3}. [{mark}] {}", "  ".repeat(task.depth), task.number, task.text)
}

#[derive(Serialize)]
struct TaskOut<'a> {
    number: usize,
    done: bool,
    moved: bool,
    depth: usize,
    text: &'a str,
}

fn list_tasks(dir: &Path, rest: &[String]) -> Result<String, Fail> {
    let parsed = parse("tasks", rest, &["--open", "--json"], &[])?;
    let note = one_when(&parsed.words)?;
    let all = notes::tasks(&read(dir, &note.id)?);
    let open = parsed.has("--open");
    let shown: Vec<&Task> = all.iter().filter(|t| !(open && (t.done || t.moved))).collect();
    if parsed.has("--json") {
        let out: Vec<TaskOut> =
            shown
            .iter()
            .map(|t| TaskOut { number: t.number, done: t.done, moved: t.moved, depth: t.depth, text: &t.text })
            .collect();
        return Ok(serde_json::to_string_pretty(&out).unwrap_or_default() + "\n");
    }
    if shown.is_empty() {
        return Ok(if open { "No open tasks.\n" } else { "No tasks.\n" }.to_string());
    }
    Ok(shown.iter().map(|t| task_line(t) + "\n").collect())
}

/// Whether ticking (`done`) or unticking a task changes it. A moved task changes either way.
fn changes(task: &Task, done: bool) -> bool {
    task.done != done || task.moved
}

/// The one task `query` names: a task number, or a text match preferring tasks not yet in the `done` state.
/// On failure, returns the candidates (empty when nothing matched).
fn find<'a>(tasks: &'a [Task], query: &str, done: bool) -> Result<&'a Task, Vec<&'a Task>> {
    if query.bytes().all(|b| b.is_ascii_digit()) {
        let number: usize = query.parse().unwrap_or(0);
        return tasks.iter().find(|t| t.number == number).ok_or_else(Vec::new);
    }
    let needle = query.to_lowercase();
    let hits: Vec<&Task> = tasks.iter().filter(|t| t.text.to_lowercase().contains(&needle)).collect();
    let preferred: Vec<&Task> = hits.iter().copied().filter(|t| changes(t, done)).collect();
    let pool = if preferred.is_empty() { hits } else { preferred };
    match pool.as_slice() {
        [one] => Ok(one),
        _ => Err(pool),
    }
}

fn tick(dir: &Path, rest: &[String], done: bool) -> Result<String, Fail> {
    let cmd = if done { "done" } else { "undo" };
    let parsed = parse(cmd, rest, &["--backlog"], &["--in"])?;
    let note = target(&parsed, "--in")?;
    let query = parsed.words.join(" ").trim().to_string();
    if query.is_empty() {
        return Err(usage(format!("which task? daybook {cmd} <number | text>")));
    }
    let markdown = read(dir, &note.id)?;
    let all = notes::tasks(&markdown);
    if all.is_empty() {
        return Err(Fail::Error(format!("{} has no tasks", note.label)));
    }
    let list_cmd = if note.label == "Today" { "daybook tasks".to_string() } else { format!("daybook tasks {}", note.id) };
    let task = find(&all, &query, done).map_err(|candidates| {
        Fail::Error(if candidates.is_empty() && query.bytes().all(|b| b.is_ascii_digit()) {
            format!("no task {query} in {} ({} tasks); see `{list_cmd}`", note.label, all.len())
        } else if candidates.is_empty() {
            format!("no task matching \"{query}\" in {}; see `{list_cmd}`", note.label)
        } else {
            let lines: Vec<String> = candidates.iter().map(|t| task_line(t)).collect();
            format!(
                "\"{query}\" matches {} tasks in {}; use a number:\n{}",
                candidates.len(),
                note.label,
                lines.join("\n")
            )
        })
    })?;
    if changes(task, done) {
        write(dir, &note.id, &notes::set_done(&markdown, task.line, done))?;
    }
    Ok(format!("{}: {}\n", if done { "Done" } else { "Reopened" }, task.text))
}

#[derive(Serialize)]
struct DayOut {
    id: String,
    label: String,
    open: usize,
    done: usize,
}

fn days(dir: &Path, rest: &[String]) -> Result<String, Fail> {
    let parsed = parse("days", rest, &["--json"], &[])?;
    if !parsed.words.is_empty() {
        return Err(usage(format!("unexpected `{}`", parsed.words.join(" "))));
    }
    let files = if dir.exists() { notes::list(dir).map_err(Fail::Error)? } else { Vec::new() };
    let mut ordered: Vec<&NoteFile> = files.iter().filter(|n| notes::is_day(&n.id)).rev().collect();
    ordered.extend(files.iter().filter(|n| !notes::is_day(&n.id) && n.id != notes::BACKLOG));
    ordered.extend(files.iter().filter(|n| n.id == notes::BACKLOG));
    let rows: Vec<DayOut> = ordered
        .iter()
        .map(|n| {
            let tasks = notes::tasks(&n.content);
            let done = tasks.iter().filter(|t| t.done).count();
            let open = tasks.iter().filter(|t| !t.done && !t.moved).count();
            DayOut { id: n.id.clone(), label: label(&n.id), open, done }
        })
        .collect();
    if parsed.has("--json") {
        return Ok(serde_json::to_string_pretty(&rows).unwrap_or_default() + "\n");
    }
    if rows.is_empty() {
        return Ok("No notes.\n".to_string());
    }
    Ok(rows
        .iter()
        .map(|r| {
            let name = if r.label == r.id { "" } else { &r.label };
            format!("{:<10}  {name:<9}  {} open · {} done\n", r.id, r.open, r.done)
        })
        .collect())
}

fn path(dir: &Path, rest: &[String]) -> Result<String, Fail> {
    if !rest.is_empty() {
        return Err(usage(format!("unexpected `{}`", rest.join(" "))));
    }
    Ok(format!("{}\n", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("daybook-cli-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(String::from).collect()
    }

    fn ok(dir: &Path, line: &str) -> String {
        let (cmd, rest) = line.split_once(' ').unwrap_or((line, ""));
        match execute(cmd, &args(rest), dir) {
            Ok(out) => out,
            Err(Fail::Usage(m) | Fail::Error(m)) => panic!("`{line}` failed: {m}"),
        }
    }

    fn code(dir: &Path, line: &str) -> i32 {
        let (cmd, rest) = line.split_once(' ').unwrap_or((line, ""));
        match execute(cmd, &args(rest), dir) {
            Ok(_) => 0,
            Err(Fail::Error(_)) => 1,
            Err(Fail::Usage(_)) => 2,
        }
    }

    #[test]
    fn starts_the_app_without_a_command() {
        assert_eq!(run(&[]), None);
        assert_eq!(run(&["-psn_0_12345".to_string()]), None);
    }

    #[test]
    fn parses_when() {
        assert_eq!(when("today").unwrap().id, notes::day_id(0));
        assert_eq!(when("Yesterday").unwrap().label, "Yesterday");
        assert_eq!(when("backlog").unwrap().label, "Backlog");
        assert_eq!(when("2020-01-05").unwrap().label, "2020-01-05");
        assert!(when("2020-13-01").is_err());
        assert!(when("monday").is_err());
    }

    #[test]
    fn adds_and_lists_tasks() {
        let tmp = TempDir::new("add");
        assert_eq!(ok(&tmp.0, "add Ship the auth fix"), "Added to Today: Ship the auth fix\n");
        assert_eq!(ok(&tmp.0, "add Review https://github.com/a/b/pull/4 --backlog"), "Added to Backlog: Review https://github.com/a/b/pull/4\n");
        assert_eq!(ok(&tmp.0, "add Plan --to tomorrow"), "Added to Tomorrow: Plan\n");
        assert_eq!(ok(&tmp.0, "show"), "- [ ] Ship the auth fix\n");
        assert_eq!(ok(&tmp.0, "tasks backlog"), "  1. [ ] Review https://github.com/a/b/pull/4\n");
        assert_eq!(code(&tmp.0, "add"), 2);
        assert_eq!(code(&tmp.0, "add x --backlog --to today"), 2);
        assert_eq!(code(&tmp.0, "add x --to someday"), 2);
    }

    #[test]
    fn lists_nested_open_and_json() {
        let tmp = TempDir::new("tasks");
        let id = notes::day_id(0);
        std::fs::create_dir_all(&tmp.0).unwrap();
        notes::write(&tmp.0, &id, "# Notes\n- [x] Done thing\n- [ ] Parent\n  - [ ] Child\n").unwrap();
        assert_eq!(ok(&tmp.0, "tasks"), "  1. [x] Done thing\n  2. [ ] Parent\n    3. [ ] Child\n");
        assert_eq!(ok(&tmp.0, "tasks --open"), "  2. [ ] Parent\n    3. [ ] Child\n");
        let json: serde_json::Value = serde_json::from_str(&ok(&tmp.0, "tasks --json --open")).unwrap();
        assert_eq!(json[1], serde_json::json!({"number": 3, "done": false, "moved": false, "depth": 1, "text": "Child"}));
        assert_eq!(ok(&tmp.0, "tasks yesterday"), "No tasks.\n");
        assert_eq!(ok(&tmp.0, "tasks yesterday --json"), "[]\n");
        assert_eq!(code(&tmp.0, "tasks --bogus"), 2);
    }

    #[test]
    fn ticks_by_number_and_text() {
        let tmp = TempDir::new("done");
        let id = notes::day_id(0);
        std::fs::create_dir_all(&tmp.0).unwrap();
        notes::write(&tmp.0, &id, "- [ ] Ship the auth fix\n- [x] Review auth PR\n- [ ] Write docs\n").unwrap();
        assert_eq!(ok(&tmp.0, "done AUTH"), "Done: Ship the auth fix\n");
        assert_eq!(code(&tmp.0, "done auth"), 1);
        assert_eq!(ok(&tmp.0, "undo 1"), "Reopened: Ship the auth fix\n");
        assert_eq!(ok(&tmp.0, "done 3"), "Done: Write docs\n");
        assert_eq!(code(&tmp.0, "done 9"), 1);
        assert_eq!(code(&tmp.0, "done nothing like this"), 1);
        assert_eq!(code(&tmp.0, "done"), 2);
        assert_eq!(notes::read(&tmp.0, &id).unwrap(), "- [ ] Ship the auth fix\n- [x] Review auth PR\n- [x] Write docs\n");
    }

    #[test]
    fn lists_and_ticks_moved_tasks() {
        let tmp = TempDir::new("moved");
        let id = notes::day_id(0);
        std::fs::create_dir_all(&tmp.0).unwrap();
        notes::write(&tmp.0, &id, "- [>] Moved one\n- [ ] Open\n- [>] Moved two\n").unwrap();
        assert_eq!(ok(&tmp.0, "tasks"), "  1. [>] Moved one\n  2. [ ] Open\n  3. [>] Moved two\n");
        assert_eq!(ok(&tmp.0, "tasks --open"), "  2. [ ] Open\n");
        let json: serde_json::Value = serde_json::from_str(&ok(&tmp.0, "tasks --json")).unwrap();
        assert_eq!(json[0]["moved"], true);
        assert_eq!(ok(&tmp.0, "days"), format!("{id}  Today      1 open · 0 done\n"));
        assert_eq!(ok(&tmp.0, "done 1"), "Done: Moved one\n");
        assert_eq!(ok(&tmp.0, "undo two"), "Reopened: Moved two\n");
        assert_eq!(notes::read(&tmp.0, &id).unwrap(), "- [x] Moved one\n- [ ] Open\n- [ ] Moved two\n");
    }

    #[test]
    fn finds_ambiguous_matches() {
        let all = notes::tasks("- [ ] auth one\n- [ ] auth two\n- [x] auth three\n");
        assert_eq!(find(&all, "auth", true).unwrap_err().len(), 2);
        assert_eq!(find(&all, "auth", false).unwrap().number, 3);
        assert_eq!(find(&all, "three", true).unwrap().number, 3);
    }

    #[test]
    fn lists_days_newest_first_backlog_last() {
        let tmp = TempDir::new("days");
        assert_eq!(ok(&tmp.0, "days"), "No notes.\n");
        std::fs::create_dir_all(&tmp.0).unwrap();
        notes::write(&tmp.0, "2020-01-01", "- [ ] a\n").unwrap();
        notes::write(&tmp.0, "2020-01-02", "- [x] b\n- [ ] c\n").unwrap();
        notes::write(&tmp.0, notes::BACKLOG, "- [ ] d\n").unwrap();
        assert_eq!(
            ok(&tmp.0, "days"),
            "2020-01-02             1 open · 1 done\n2020-01-01             1 open · 0 done\nbacklog     Backlog    1 open · 0 done\n"
        );
        let json: serde_json::Value = serde_json::from_str(&ok(&tmp.0, "days --json")).unwrap();
        assert_eq!(json[2], serde_json::json!({"id": "backlog", "label": "Backlog", "open": 1, "done": 0}));
    }

    #[test]
    fn rejects_unknown_commands_and_shows_help() {
        let tmp = TempDir::new("help");
        assert_eq!(code(&tmp.0, "frobnicate"), 2);
        assert!(ok(&tmp.0, "help").contains("daybook add"));
        assert!(ok(&tmp.0, "add --help").contains("Exit codes"));
        assert_eq!(code(&tmp.0, "path extra"), 2);
    }
}
