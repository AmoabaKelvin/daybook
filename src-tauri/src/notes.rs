//! Note storage shared by the app and the `daybook` CLI: one markdown file per note.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const BACKLOG: &str = "backlog";
const KEEP_WHEN_EMPTY: &[&str] = &[BACKLOG];

#[derive(Serialize, Clone)]
pub struct NoteFile {
    pub id: String,
    pub content: String,
    pub updated: f64,
}

/// Notes live in ~/Daybook, or $DAYBOOK_DIR when it is set.
pub fn dir() -> PathBuf {
    if let Ok(dir) = std::env::var("DAYBOOK_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    Path::new(&home).join("Daybook")
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The note id for a day, like "2026-10-20", in local time. `offset` is in days from today.
pub fn day_id(offset: i64) -> String {
    (chrono::Local::now().date_naive() + chrono::Duration::days(offset)).format("%Y-%m-%d").to_string()
}

pub fn is_day(id: &str) -> bool {
    chrono::NaiveDate::parse_from_str(id, "%Y-%m-%d").is_ok()
}

/// The note id a file path belongs to, if it is a note.
pub fn id_for_path(path: &Path) -> Option<String> {
    let id = path.file_name()?.to_str()?.strip_suffix(".md")?;
    valid_id(id).then(|| id.to_string())
}

fn path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if valid_id(id) {
        Ok(dir.join(format!("{id}.md")))
    } else {
        Err(format!("invalid note id: {id}"))
    }
}

pub fn list(dir: &Path) -> Result<Vec<NoteFile>, String> {
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut notes = Vec::new();
    for entry in entries.flatten() {
        let Some(id) = id_for_path(&entry.path()) else { continue };
        let content = fs::read_to_string(entry.path()).unwrap_or_default();
        let updated = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        notes.push(NoteFile { id, content, updated });
    }
    notes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(notes)
}

/// A note's markdown, or an empty string when it does not exist yet.
pub fn read(dir: &Path, id: &str) -> Result<String, String> {
    Ok(fs::read_to_string(path(dir, id)?).unwrap_or_default())
}

/// Writes a note atomically. An empty day is deleted rather than kept as an empty file.
/// Returns the exact content now on disk ("" when deleted).
pub fn write(dir: &Path, id: &str, content: &str) -> Result<String, String> {
    let path = path(dir, id)?;
    if content.trim().is_empty() && !KEEP_WHEN_EMPTY.contains(&id) {
        let _ = fs::remove_file(&path);
        return Ok(String::new());
    }
    let body = if content.ends_with('\n') { content.to_string() } else { format!("{content}\n") };
    let tmp = path.with_extension(format!("md.{}.tmp", std::process::id()));
    fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(body)
}

fn is_task(line: &str) -> bool {
    let trimmed = line.trim_start();
    ["- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] ", "+ [ ] ", "+ [x] "].iter().any(|p| trimmed.starts_with(p))
}

/// Appends a task line, joining the list the note ends with (same rule as the app's appendToMarkdown).
pub fn append_task(markdown: &str, text: &str) -> String {
    let body = markdown.trim_end();
    let task = format!("- [ ] {}", text.trim());
    if body.is_empty() {
        return format!("{task}\n");
    }
    let joins = body.lines().last().is_some_and(is_task);
    format!("{body}{}{task}\n", if joins { "\n" } else { "\n\n" })
}

#[derive(Serialize, Clone, Debug)]
pub struct Task {
    /// 1-based, counted over every task in the note in order.
    pub number: usize,
    /// 0-based line index in the note.
    pub line: usize,
    pub done: bool,
    pub depth: usize,
    pub text: String,
}

/// Every task in a note, in order, nested ones included.
pub fn tasks(markdown: &str) -> Vec<Task> {
    let mut found = Vec::new();
    for (line, raw) in markdown.lines().enumerate() {
        if !is_task(raw) {
            continue;
        }
        let indent = raw.len() - raw.trim_start().len();
        let rest = raw.trim_start();
        found.push(Task {
            number: found.len() + 1,
            line,
            done: !rest[2..].starts_with("[ ]"),
            depth: indent / 2,
            text: rest[6..].to_string(),
        });
    }
    found
}

/// Sets a task line's checkbox. `line` is a 0-based line index from `tasks`.
pub fn set_done(markdown: &str, line: usize, done: bool) -> String {
    let mut lines: Vec<String> = markdown.lines().map(String::from).collect();
    if let Some(raw) = lines.get_mut(line) {
        let indent = raw.len() - raw.trim_start().len();
        if is_task(raw) {
            let mark = if done { "x" } else { " " };
            raw.replace_range(indent + 3..indent + 4, mark);
        }
    }
    let mut out = lines.join("\n");
    if markdown.ends_with('\n') {
        out.push('\n');
    }
    out
}
