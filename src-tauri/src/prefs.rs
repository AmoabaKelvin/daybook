//! Small app preferences, kept as JSON in the app's config folder so the CLI can read them too.

use crate::providers::AgentPrefs;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const IDENTIFIER: &str = "com.kelvinamoaba.daybook";
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// An accelerator like "Alt+Space", or None when quick capture is off.
    pub capture_shortcut: Option<String>,
    pub agent: AgentPrefs,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { capture_shortcut: Some(DEFAULT_SHORTCUT.into()), agent: AgentPrefs::default() }
    }
}

/// Where Tauri's app_config_dir points on macOS.
fn path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Library/Application Support").join(IDENTIFIER).join("prefs.json")
}

pub fn load() -> Prefs {
    fs::read_to_string(path()).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// Reads, changes and writes the prefs, so one setting never clobbers another.
pub fn update(change: impl FnOnce(&mut Prefs)) -> Result<Prefs, String> {
    let mut prefs = load();
    change(&mut prefs);
    let path = path();
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(path, serde_json::to_string_pretty(&prefs).unwrap()).map_err(|e| e.to_string())?;
    Ok(prefs)
}
