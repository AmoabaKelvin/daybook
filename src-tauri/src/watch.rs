//! Tells the page when a note changes on disk because of something other than the app,
//! like the `daybook` CLI, an agent, or another editor.

use crate::notes;
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// What the app itself last wrote to each note, so its own saves don't echo back.
pub type Written = Arc<Mutex<HashMap<String, String>>>;

#[derive(Serialize, Clone)]
struct Changed {
    id: String,
    content: String,
}

pub fn start(app: AppHandle, dir: &Path, written: Written) -> Result<Debouncer<RecommendedWatcher>, String> {
    let mut debouncer = new_debouncer(Duration::from_millis(150), move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        for event in events {
            let Some(id) = notes::id_for_path(&event.path) else { continue };
            let content = fs::read_to_string(&event.path).unwrap_or_default();
            if written.lock().unwrap().get(&id) == Some(&content) {
                continue;
            }
            let _ = app.emit("daybook://changed", Changed { id, content });
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer.watcher().watch(dir, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    Ok(debouncer)
}
