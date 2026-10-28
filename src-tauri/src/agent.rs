//! The agent: you say what's on your plate in your own words, and a model proposes
//! changes to your notes (add, tick, move, edit, remove). You look them over first;
//! the model only ever proposes, and Daybook does the writing.

use crate::assigned::Assigned;
use crate::notes::{self, Task};
use crate::providers::Message;
use chrono::{Datelike, Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Past days whose open tasks the model sees, for "the thing from Friday".
const PAST_DAYS: i64 = 7;
const CALENDAR_DAYS: i64 = 14;

pub const SYSTEM: &str = "\
You are the planning assistant inside Daybook, a personal app of daily task notes. Each day is a \
note, and there is a backlog for things with no day. The user tells you what they need to do, in any \
shape: pasted Slack or GitHub links, a brain dump, a correction. You turn it into changes to their notes, \
which they review before anything is written.

Changes:
- add: a new task. `note` is the day (YYYY-MM-DD) or \"backlog\". `text` is the task, `subtasks` are its steps.
- done: tick off an existing task.
- move: move an existing task (and its sub-tasks) to `note`.
- edit: rewrite an existing task's `text`.
- remove: delete an existing task. Only when the user asks to drop or delete it.
Existing tasks are named by their id, like 2026-10-26:3, in `task`. Leave fields you don't use empty.

Placing things:
- No time given means today. \"Tomorrow\" is the next day. A weekday name is its next date (today if \
it's today). \"Next week\" is next Monday. \"End of the week\" is Friday. Use the calendar you're given.
- \"Someday\", \"later\", \"eventually\", \"at some point\", or nothing to do with a date: the backlog.
- One thing to do is one task. Steps the user lists for it are its subtasks, not separate tasks.
- Before adding, look at the notes: don't add what's already there, and prefer done, move or edit when \
the user is talking about an existing task.

Writing tasks:
- Short and plain, like a person's todo list: start with a verb when it reads naturally (\"Review\", \
\"Reply to\", \"Fix\"). No trailing period, no dates in the text, no markdown besides what the user wrote.
- Keep every URL the user gave, written bare (https://...), never as a markdown link. Daybook shows \
GitHub, Linear and Slack URLs as titled chips, so don't repeat the title next to its URL.
- When the user means something in their assigned GitHub or Linear work (\"the auth PR\", \"Ama's review\", \
\"the billing ticket\"), use that item's URL.
- Never invent work the user didn't mention.

Replying:
- `reply` is one or two short, friendly sentences in plain text (no markdown, no lists): what you're \
proposing, or the answer to a question. Don't repeat every change; Daybook shows them.
- A question about the notes (\"what's left today?\") gets an answer and no changes.
- If you can't tell what the user wants, ask one short question and propose nothing.
- If your last proposal wasn't applied and the user adjusts it, return the whole revised proposal: it \
replaces the old one.";

/// The shape the model answers in. Every field is required so it works in strict mode everywhere.
pub fn schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["reply", "changes"],
        "properties": {
            "reply": { "type": "string" },
            "changes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["action", "task", "note", "text", "subtasks"],
                    "properties": {
                        "action": { "type": "string", "enum": ["add", "done", "move", "edit", "remove"] },
                        "task": { "type": "string", "description": "An existing task's id, like 2026-10-26:3. Empty for add." },
                        "note": { "type": "string", "description": "For add and move: YYYY-MM-DD or backlog. Otherwise empty." },
                        "text": { "type": "string", "description": "For add and edit: the task's text. Otherwise empty." },
                        "subtasks": { "type": "array", "items": { "type": "string" } }
                    }
                }
            }
        }
    })
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Add,
    Done,
    Move,
    Edit,
    Remove,
}

/// An existing task a change is about, as it was when the change was proposed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TaskRef {
    pub note: String,
    pub line: usize,
    pub text: String,
}

/// One proposed change, checked against the notes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Change {
    pub action: Action,
    /// Where an added or moved task goes; otherwise the note the task is in.
    pub note: String,
    /// The new text for add and edit.
    pub text: String,
    pub subtasks: Vec<String>,
    /// The existing task, for everything but add.
    pub task: Option<TaskRef>,
}

#[derive(Serialize, Debug)]
pub struct Plan {
    pub reply: String,
    pub changes: Vec<Change>,
}

/// A turn earlier in the conversation. An assistant turn carries what it proposed and whether it was applied.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub changes: Vec<Change>,
    #[serde(default)]
    pub applied: bool,
}

#[derive(Deserialize)]
struct Answer {
    reply: String,
    changes: Vec<Proposed>,
}

#[derive(Deserialize)]
struct Proposed {
    action: Action,
    #[serde(default)]
    task: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    subtasks: Vec<String>,
}

fn weekday(date: NaiveDate) -> String {
    date.format("%A").to_string()
}

fn today() -> NaiveDate {
    Local::now().date_naive()
}

/// A conversation as the model has seen it, so a follow-up sends only what's new. The notes and
/// assigned work go with the first message; after that, only the notes that changed.
#[derive(Clone)]
pub struct Chat {
    day: NaiveDate,
    /// Each note as the model last saw it.
    seen: BTreeMap<String, String>,
    /// The turns so far, as the app shows them, to tell a follow-up from a new chat.
    turns: Vec<(String, String)>,
    pub messages: Vec<Message>,
}

impl Chat {
    /// The chat with the latest turn added. It follows on from `previous` when the turns before the
    /// latest are the ones `previous` had; otherwise it starts over with everything.
    pub fn next(previous: Option<&Chat>, dir: &Path, assigned: impl FnOnce() -> Option<Assigned>, turns: &[Turn]) -> Chat {
        let today = today();
        let (latest, earlier) = turns.split_last().map_or(("", &[][..]), |(last, rest)| (last.text.trim(), rest));
        let before: Vec<(String, String)> = earlier.iter().map(said).collect();
        match previous.filter(|chat| chat.day == today && !before.is_empty() && chat.turns == before) {
            Some(chat) => chat.follow_up(dir, earlier.last(), latest),
            None => Chat::start(dir, today, assigned().as_ref(), earlier, latest),
        }
    }

    fn start(dir: &Path, today: NaiveDate, assigned: Option<&Assigned>, earlier: &[Turn], latest: &str) -> Chat {
        let mut out = format!("Today is {} {} ({}).\n\nCalendar:", weekday(today), today.format("%-d %B %Y"), today.format("%Y-%m-%d"));
        for offset in 1..=CALENDAR_DAYS {
            let day = today + Duration::days(offset);
            let marker = if day.weekday() == chrono::Weekday::Mon { " (next week starts)" } else { "" };
            out += &format!("\n- {} {}{}", &weekday(day)[..3], day.format("%Y-%m-%d"), if offset <= 7 { marker } else { "" });
        }

        let notes = notes_in_view(dir, today);
        out += "\n\n<notes>\nTasks are listed as `id [ ] text`; [x] is done, [>] was moved to another day. Sub-tasks are indented.\n";
        for (id, label, markdown) in &notes {
            out += &listing(id, label, markdown, today);
        }
        out += "</notes>\n";

        if let Some(assigned) = assigned {
            out += "\n<assigned>\nOpen GitHub and Linear work assigned to the user or waiting on their review.\n";
            let items = assigned.github.iter().flatten().chain(assigned.linear.iter().flatten());
            for item in items {
                let what = if item.group == "review" { "review requested" } else { "assigned" };
                let status = item.status.as_deref().unwrap_or(&item.state);
                let updated = chrono::DateTime::from_timestamp_millis(item.updated).map(|t| t.format(", updated %Y-%m-%d").to_string()).unwrap_or_default();
                let kind = if item.kind == "pull" { "PR" } else { "issue" };
                out += &format!("- {} {kind} {} \"{}\" ({what}, {status}{updated}) {}\n", item.source, item.reference, clip(&item.title, 160), item.url);
            }
            out += "</assigned>\n";
        }

        // Only when the conversation started somewhere that didn't keep it, like the dev server.
        if !earlier.is_empty() {
            out += "\n<conversation>\n";
            for turn in earlier {
                if turn.role == "user" {
                    out += &format!("User: {}\n", turn.text.trim());
                    continue;
                }
                out += &format!("You: {}\n", turn.text.trim());
                if !turn.changes.is_empty() {
                    let state = if turn.applied { "applied, so the notes above include them" } else { "not applied" };
                    out += &format!("  Proposed ({state}):\n");
                    for change in &turn.changes {
                        out += &format!("  - {}\n", describe(change));
                    }
                }
            }
            out += "</conversation>\n";
        }
        out += &format!("\nThe user says:\n{latest}\n");

        let mut turns: Vec<(String, String)> = earlier.iter().map(said).collect();
        turns.push(("user".into(), latest.into()));
        let seen = notes.into_iter().map(|(id, _, markdown)| (id, markdown)).collect();
        Chat { day: today, seen, turns, messages: vec![Message::User(out)] }
    }

    fn follow_up(&self, dir: &Path, last: Option<&Turn>, latest: &str) -> Chat {
        let mut chat = self.clone();
        let mut out = String::new();
        if let Some(last) = last.filter(|t| t.role == "assistant" && !t.changes.is_empty()) {
            out += if last.applied { "The user applied your last proposal.\n" } else { "The user didn't apply your last proposal.\n" };
        }
        let changed: Vec<_> = notes_in_view(dir, self.day).into_iter().filter(|(id, _, markdown)| self.seen.get(id) != Some(markdown)).collect();
        if !changed.is_empty() {
            out += "\n<notes>\nThese notes changed since you last saw them. Use these tasks and ids for them now:\n";
            for (id, label, markdown) in changed {
                out += &listing(&id, &label, &markdown, self.day);
                chat.seen.insert(id, markdown);
            }
            out += "</notes>\n";
        }
        out += &format!("\nThe user says:\n{latest}\n");
        chat.turns.push(("user".into(), latest.into()));
        chat.messages.push(Message::User(out));
        chat
    }

    /// Adds the model's answer, once it's been read.
    pub fn answered(&mut self, answer: &str, plan: &Plan) {
        self.turns.push(("assistant".into(), plan.reply.clone()));
        self.messages.push(Message::Assistant(answer.into()));
    }
}

fn said(turn: &Turn) -> (String, String) {
    (turn.role.clone(), turn.text.trim().to_string())
}

/// One note's tasks with their ids. A past day shows only what's still open.
fn listing(id: &str, label: &str, markdown: &str, today: NaiveDate) -> String {
    let mut out = format!("\n## {label}\n");
    let tasks = notes::tasks(markdown);
    let shown: Vec<&Task> = tasks.iter().filter(|t| id == notes::BACKLOG || !is_past(id, today) || (!t.done && !t.moved)).collect();
    if shown.is_empty() {
        out += "(no tasks)\n";
    }
    for task in shown {
        let mark = if task.done { "x" } else if task.moved { ">" } else { " " };
        out += &format!("{}{id}:{} [{mark}] {}\n", "  ".repeat(task.depth), task.number, clip(&task.text, 300));
    }
    out
}

/// Today, the days ahead that have notes, the last week, and the backlog.
fn notes_in_view(dir: &Path, today: NaiveDate) -> Vec<(String, String, String)> {
    let today_id = today.format("%Y-%m-%d").to_string();
    let oldest = (today - Duration::days(PAST_DAYS)).format("%Y-%m-%d").to_string();
    let mut days: Vec<(String, String)> = notes::list(dir)
        .unwrap_or_default()
        .into_iter()
        .filter(|n| notes::is_day(&n.id) && n.id >= oldest && n.id != today_id)
        .map(|n| (n.id, n.content))
        .collect();
    days.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = vec![(today_id.clone(), format!("Today, {}", label(&today_id)), notes::read(dir, &today_id).unwrap_or_default())];
    for (id, content) in days {
        let past = id < today_id;
        let label = format!("{}{}", label(&id), if past { " (past, open tasks only)" } else { "" });
        out.push((id, label, content));
    }
    out.push((notes::BACKLOG.into(), "Backlog".into(), notes::read(dir, notes::BACKLOG).unwrap_or_default()));
    out
}

fn is_past(id: &str, today: NaiveDate) -> bool {
    NaiveDate::parse_from_str(id, "%Y-%m-%d").is_ok_and(|d| d < today)
}

fn label(id: &str) -> String {
    match NaiveDate::parse_from_str(id, "%Y-%m-%d") {
        Ok(date) => format!("{} {id}", weekday(date)),
        Err(_) => id.into(),
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max - 1).collect::<String>())
}

/// A change in a line, for the conversation history.
fn describe(change: &Change) -> String {
    let task = change.task.as_ref().map(|t| format!("\"{}\" in {}", clip(&t.text, 120), t.note)).unwrap_or_default();
    match change.action {
        Action::Add => {
            let subtasks = if change.subtasks.is_empty() { String::new() } else { format!(" with sub-tasks {:?}", change.subtasks) };
            format!("add \"{}\" to {}{subtasks}", change.text, change.note)
        }
        Action::Done => format!("tick off {task}"),
        Action::Move => format!("move {task} to {}", change.note),
        Action::Edit => format!("rewrite {task} as \"{}\"", change.text),
        Action::Remove => format!("remove {task}"),
    }
}

/// Reads the model's answer and keeps only the changes that make sense against the notes.
pub fn plan(dir: &Path, answer: &str) -> Result<Plan, String> {
    let answer: Answer = serde_json::from_str(answer).map_err(|_| "The agent's answer didn't make sense. Try again?".to_string())?;
    let today = today();
    let mut changes: Vec<Change> = Vec::new();
    for proposed in answer.changes {
        if let Some(change) = check(dir, proposed, today) {
            if !changes.contains(&change) {
                changes.push(change);
            }
        }
    }
    Ok(Plan { reply: answer.reply.trim().to_string(), changes })
}

fn check(dir: &Path, proposed: Proposed, today: NaiveDate) -> Option<Change> {
    let text = task_text(&proposed.text);
    let subtasks: Vec<String> = proposed.subtasks.iter().map(|s| task_text(s)).filter(|s| !s.is_empty()).collect();
    if proposed.action == Action::Add {
        let note = destination(&proposed.note, today)?;
        return (!text.is_empty()).then_some(Change { action: Action::Add, note, text, subtasks, task: None });
    }
    let task = find(dir, &proposed.task)?;
    match proposed.action {
        Action::Done => (!task.1.done).then(|| Change { action: Action::Done, note: task.0.note.clone(), text: String::new(), subtasks: vec![], task: Some(task.0) }),
        Action::Move => {
            let note = destination(&proposed.note, today)?;
            (note != task.0.note).then(|| Change { action: Action::Move, note, text: String::new(), subtasks: vec![], task: Some(task.0) })
        }
        Action::Edit => (!text.is_empty() && text != task.0.text)
            .then(|| Change { action: Action::Edit, note: task.0.note.clone(), text, subtasks: vec![], task: Some(task.0) }),
        Action::Remove => Some(Change { action: Action::Remove, note: task.0.note.clone(), text: String::new(), subtasks: vec![], task: Some(task.0) }),
        Action::Add => None,
    }
}

/// A task's text on one line, without a checkbox the model may have added.
fn task_text(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut text = text.as_str();
    for prefix in ["- [ ] ", "- [x] ", "- [>] ", "[ ] ", "- "] {
        text = text.strip_prefix(prefix).unwrap_or(text);
    }
    text.trim().to_string()
}

/// A day or the backlog. Days in the past become today.
fn destination(note: &str, today: NaiveDate) -> Option<String> {
    let note = note.trim().to_ascii_lowercase();
    if note == notes::BACKLOG {
        return Some(note);
    }
    let date = NaiveDate::parse_from_str(&note, "%Y-%m-%d").ok()?;
    Some(date.max(today).format("%Y-%m-%d").to_string())
}

/// An existing task from an id like "2026-10-26:3".
fn find(dir: &Path, id: &str) -> Option<(TaskRef, Task)> {
    let (note, number) = id.trim().rsplit_once(':')?;
    let number: usize = number.parse().ok()?;
    if !notes::valid_id(note) {
        return None;
    }
    let task = notes::tasks(&notes::read(dir, note).ok()?).into_iter().find(|t| t.number == number)?;
    Some((TaskRef { note: note.to_string(), line: task.line, text: task.text.clone() }, task))
}

/// A note before and after applying a plan, so the plan can be undone.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Snapshot {
    pub id: String,
    pub before: String,
    pub after: String,
}

/// Applies the changes in order and writes each note once. Returns what to put back to undo it.
pub fn apply(dir: &Path, changes: &[Change]) -> Result<Vec<Snapshot>, String> {
    // Each note's markdown before and as the changes go.
    let mut working: BTreeMap<String, (String, String)> = BTreeMap::new();
    let note = |working: &mut BTreeMap<String, (String, String)>, id: &str| -> Result<String, String> {
        if !working.contains_key(id) {
            let markdown = notes::read(dir, id)?;
            working.insert(id.to_string(), (markdown.clone(), markdown));
        }
        Ok(working[id].1.clone())
    };
    let mut edits: Vec<(String, String)> = Vec::new();
    let mut missing = 0;

    for change in changes {
        match (&change.task, change.action) {
            (None, Action::Add) => {
                let markdown = note(&mut working, &change.note)?;
                edits.push((change.note.clone(), notes::append_tasks(&markdown, &block(&change.text, &change.subtasks))));
            }
            (Some(task), action) => {
                let markdown = note(&mut working, &task.note)?;
                let Some(line) = locate(&markdown, task) else {
                    missing += 1;
                    continue;
                };
                match action {
                    Action::Done => edits.push((task.note.clone(), notes::set_done(&markdown, line, true))),
                    Action::Edit => edits.push((task.note.clone(), set_text(&markdown, line, &change.text))),
                    Action::Remove => edits.push((task.note.clone(), without(&markdown, line).0)),
                    Action::Move => {
                        let (rest, moved) = without(&markdown, line);
                        let left = if task.note == notes::BACKLOG { rest } else { mark_moved(&markdown, line) };
                        edits.push((task.note.clone(), left));
                        let target = note(&mut working, &change.note)?;
                        edits.push((change.note.clone(), notes::append_tasks(&target, &reopen(&moved))));
                    }
                    Action::Add => {}
                }
            }
            (None, _) => missing += 1,
        }
        for (id, markdown) in edits.drain(..) {
            working.get_mut(&id).unwrap().1 = markdown;
        }
    }

    if missing == changes.len() && missing > 0 {
        return Err("Those tasks changed since the agent looked. Ask again?".into());
    }
    let mut snapshots = Vec::new();
    for (id, (before, after)) in working {
        if before == after {
            continue;
        }
        let after = notes::write(dir, &id, &after)?;
        snapshots.push(Snapshot { id, before, after });
    }
    Ok(snapshots)
}

/// Puts notes back as they were, unless they've changed since. Returns how many couldn't be.
pub fn undo(dir: &Path, snapshots: &[Snapshot]) -> Result<usize, String> {
    let mut skipped = 0;
    for snapshot in snapshots {
        if notes::read(dir, &snapshot.id)?.trim_end() != snapshot.after.trim_end() {
            skipped += 1;
            continue;
        }
        notes::write(dir, &snapshot.id, &snapshot.before)?;
    }
    Ok(skipped)
}

fn block(text: &str, subtasks: &[String]) -> String {
    std::iter::once(format!("- [ ] {text}")).chain(subtasks.iter().map(|s| format!("  - [ ] {s}"))).collect::<Vec<_>>().join("\n")
}

/// The task's line now: where it was if it's still there, otherwise the first task with the same text.
fn locate(markdown: &str, task: &TaskRef) -> Option<usize> {
    let tasks = notes::tasks(markdown);
    tasks
        .iter()
        .find(|t| t.line == task.line && t.text == task.text)
        .or_else(|| tasks.iter().find(|t| t.text == task.text))
        .map(|t| t.line)
}

fn lines(markdown: &str) -> Vec<String> {
    markdown.lines().map(String::from).collect()
}

fn join(lines: &[String], like: &str) -> String {
    let mut out = lines.join("\n");
    if like.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    out
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// The task's line and everything nested under it.
fn subtree(lines: &[String], line: usize) -> std::ops::Range<usize> {
    let depth = indent(&lines[line]);
    let end = (line + 1..lines.len()).find(|&i| !lines[i].trim().is_empty() && indent(&lines[i]) <= depth).unwrap_or(lines.len());
    // Blank lines just before the next block belong to it, not to this task.
    let end = (line + 1..end).rev().find(|&i| !lines[i].trim().is_empty()).map_or(line + 1, |i| i + 1);
    line..end
}

/// The note without the task and its sub-tasks, and the removed lines.
fn without(markdown: &str, line: usize) -> (String, Vec<String>) {
    let mut all = lines(markdown);
    let range = subtree(&all, line);
    let removed: Vec<String> = all.drain(range).collect();
    (join(&all, markdown), removed)
}

/// Marks the task and its open sub-tasks as moved ("- [>] "), like bringing tasks over to a new day does.
fn mark_moved(markdown: &str, line: usize) -> String {
    let mut all = lines(markdown);
    for i in subtree(&all, line) {
        let at = indent(&all[i]);
        if matches!(all[i].get(at..at + 6), Some("- [ ] " | "* [ ] " | "+ [ ] ")) {
            all[i].replace_range(at + 3..at + 4, ">");
        }
    }
    join(&all, markdown)
}

/// Moved lines as a top-level open task: indents shifted back, moved marks opened again.
fn reopen(moved: &[String]) -> String {
    let base = moved.first().map_or(0, |l| indent(l));
    moved
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let line = if indent(line) >= base { &line[base..] } else { line.as_str() };
            let at = indent(line);
            let rest = &line[at..];
            match rest.get(..6) {
                Some("- [>] " | "* [>] " | "+ [>] ") => format!("{}{}[ ] {}", &line[..at], &rest[..2], &rest[6..]),
                _ if i == 0 && rest.get(..6).is_some_and(|p| p.ends_with("] ")) => format!("- [ ] {}", &rest[6..]),
                _ => line.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn set_text(markdown: &str, line: usize, text: &str) -> String {
    let mut all = lines(markdown);
    let at = indent(&all[line]);
    all[line] = format!("{}{}", &all[line][..at + 6], text);
    join(&all, markdown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Dir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("daybook-agent-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Dir(dir)
        }
        fn write(&self, id: &str, content: &str) {
            fs::write(self.0.join(format!("{id}.md")), content).unwrap();
        }
        fn read(&self, id: &str) -> String {
            notes::read(&self.0, id).unwrap()
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn day(offset: i64) -> String {
        notes::day_id(offset)
    }

    fn answer(changes: serde_json::Value) -> String {
        serde_json::json!({ "reply": "ok", "changes": changes }).to_string()
    }

    #[test]
    fn checks_proposals_against_the_notes() {
        let dir = Dir::new("check");
        dir.write(&day(0), "- [ ] Review PR\n- [x] Done already\n");
        let today = day(0);
        let plan = plan(
            &dir.0,
            &answer(serde_json::json!([
                { "action": "add", "task": "", "note": day(-3), "text": "- [ ] Past day becomes today", "subtasks": ["  one ", ""] },
                { "action": "add", "task": "", "note": "someday", "text": "Bad note", "subtasks": [] },
                { "action": "done", "task": format!("{today}:1"), "note": "", "text": "", "subtasks": [] },
                { "action": "done", "task": format!("{today}:2"), "note": "", "text": "", "subtasks": [] },
                { "action": "move", "task": format!("{today}:9"), "note": "backlog", "text": "", "subtasks": [] },
                { "action": "move", "task": format!("{today}:1"), "note": "BACKLOG", "text": "", "subtasks": [] },
                { "action": "edit", "task": format!("{today}:1"), "note": "", "text": "Review PR", "subtasks": [] },
            ])),
        )
        .unwrap();
        let summary: Vec<(Action, &str, &str)> = plan.changes.iter().map(|c| (c.action, c.note.as_str(), c.text.as_str())).collect();
        assert_eq!(summary, [(Action::Add, today.as_str(), "Past day becomes today"), (Action::Done, today.as_str(), ""), (Action::Move, "backlog", "")]);
        assert_eq!(plan.changes[0].subtasks, ["one"]);
        assert_eq!(plan.changes[1].task.as_ref().unwrap().text, "Review PR");
    }

    #[test]
    fn applies_and_undoes() {
        let dir = Dir::new("apply");
        let (today, tomorrow) = (day(0), day(1));
        dir.write(&today, "# Notes\n\n- [ ] Ship it\n  - [x] tests\n  - [ ] docs\n- [ ] Old name\n- [ ] Drop me\n  - [ ] child\n");
        dir.write("backlog", "- [ ] Learn zig\n");
        let task = |note: &str, line: usize, text: &str| Some(TaskRef { note: note.into(), line, text: text.into() });
        let change = |action, note: &str, text: &str, task| Change { action, note: note.into(), text: text.into(), subtasks: vec![], task };
        let changes = vec![
            change(Action::Remove, &today, "", task(&today, 5, "Drop me")),
            change(Action::Move, &tomorrow, "", task(&today, 2, "Ship it")),
            change(Action::Edit, &today, "New name", task(&today, 5, "Old name")),
            change(Action::Move, &today, "", task("backlog", 0, "Learn zig")),
            Change { subtasks: vec!["a".into()], ..change(Action::Add, &tomorrow, "Plan [it](https://x.y)", None) },
            change(Action::Done, &today, "", task(&today, 0, "Gone")),
        ];
        let snapshots = apply(&dir.0, &changes).unwrap();
        assert_eq!(dir.read(&today), "# Notes\n\n- [>] Ship it\n  - [x] tests\n  - [>] docs\n- [ ] New name\n- [ ] Learn zig\n");
        assert_eq!(dir.read(&tomorrow), "- [ ] Ship it\n  - [x] tests\n  - [ ] docs\n- [ ] Plan [it](https://x.y)\n  - [ ] a\n");
        assert_eq!(dir.read("backlog").trim(), "");
        assert_eq!(snapshots.len(), 3);

        assert_eq!(undo(&dir.0, &snapshots).unwrap(), 0);
        assert_eq!(dir.read(&today), "# Notes\n\n- [ ] Ship it\n  - [x] tests\n  - [ ] docs\n- [ ] Old name\n- [ ] Drop me\n  - [ ] child\n");
        assert_eq!(dir.read(&tomorrow), "");
        assert_eq!(dir.read("backlog"), "- [ ] Learn zig\n");
    }

    #[test]
    fn undo_leaves_notes_changed_since() {
        let dir = Dir::new("undo");
        let today = day(0);
        let snapshots = apply(&dir.0, &[Change { action: Action::Add, note: today.clone(), text: "a".into(), subtasks: vec![], task: None }]).unwrap();
        dir.write(&today, "- [ ] a\n- [ ] typed since\n");
        assert_eq!(undo(&dir.0, &snapshots).unwrap(), 1);
        assert_eq!(dir.read(&today), "- [ ] a\n- [ ] typed since\n");
    }

    #[test]
    fn moving_a_nested_task_brings_it_to_the_top_level() {
        assert_eq!(reopen(&["  - [>] child".into(), "    - [x] done".into()]), "- [ ] child\n  - [x] done");
        assert_eq!(reopen(&["- [ ] plain".into()]), "- [ ] plain");
    }

    #[test]
    fn prompt_lists_tasks_with_ids() {
        let dir = Dir::new("prompt");
        let (today, past) = (day(0), day(-2));
        dir.write(&today, "- [ ] First\n  - [x] sub\n");
        dir.write(&past, "- [x] finished\n- [ ] still open\n");
        dir.write(&day(-30), "- [ ] too old\n");
        let turns = vec![
            Turn { role: "user".into(), text: "add zig".into(), changes: vec![], applied: false },
            Turn {
                role: "assistant".into(),
                text: "Added it.".into(),
                changes: vec![Change { action: Action::Add, note: "backlog".into(), text: "Learn zig".into(), subtasks: vec![], task: None }],
                applied: true,
            },
            Turn { role: "user".into(), text: "  thanks  ".into(), changes: vec![], applied: false },
        ];
        let chat = Chat::next(None, &dir.0, || None, &turns);
        let [Message::User(prompt)] = &chat.messages[..] else { panic!("one message") };
        assert!(prompt.contains(&format!("{today}:1 [ ] First\n  {today}:2 [x] sub\n")));
        assert!(prompt.contains(&format!("{past}:2 [ ] still open")) && !prompt.contains("finished") && !prompt.contains("too old"));
        assert!(prompt.contains("- add \"Learn zig\" to backlog"));
        assert!(prompt.ends_with("The user says:\nthanks\n"));
    }

    #[test]
    fn follow_ups_send_only_what_changed() {
        let dir = Dir::new("follow");
        let today = day(0);
        dir.write(&today, "- [ ] Review PR\n");
        dir.write(notes::BACKLOG, "- [ ] Learn zig\n");
        let user = |text: &str| Turn { role: "user".into(), text: text.into(), changes: vec![], applied: false };
        let mut turns = vec![user("tick the review")];
        let mut chat = Chat::next(None, &dir.0, || None, &turns);
        let answer = answer(serde_json::json!([{ "action": "done", "task": format!("{today}:1"), "note": "", "text": "", "subtasks": [] }]));
        let first = plan(&dir.0, &answer).unwrap();
        chat.answered(&answer, &first);

        apply(&dir.0, &first.changes).unwrap();
        turns.push(Turn { role: "assistant".into(), text: first.reply.clone(), changes: first.changes, applied: true });
        turns.push(user("thanks"));
        let next = Chat::next(Some(&chat), &dir.0, || panic!("assigned work only goes in once"), &turns);
        assert_eq!(next.messages.len(), 3);
        let Message::User(sent) = &next.messages[2] else { panic!("a user message") };
        assert!(sent.starts_with("The user applied your last proposal."));
        assert!(sent.contains(&format!("{today}:1 [x] Review PR")) && !sent.contains("Learn zig"));
        assert!(sent.ends_with("The user says:\nthanks\n"));

        // A thread the chat didn't see, like after a new chat, starts over.
        let fresh = Chat::next(Some(&chat), &dir.0, || None, &[user("hello")]);
        let [Message::User(sent)] = &fresh.messages[..] else { panic!("one message") };
        assert!(sent.contains("Learn zig"));
    }
}
