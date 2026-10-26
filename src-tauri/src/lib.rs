mod assigned;
pub mod cli;
mod links;
pub mod notes;
mod quick;
mod tray;
mod watch;

use links::{LinearAccount, LinkInfo, Links};
use notify_debouncer_mini::{notify::RecommendedWatcher, Debouncer};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

struct State {
    dir: PathBuf,
    written: watch::Written,
    links: Links,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    shortcut: Mutex<quick::ShortcutStatus>,
}

#[tauri::command]
fn list_notes(state: tauri::State<State>) -> Result<Vec<notes::NoteFile>, String> {
    notes::list(&state.dir)
}

#[tauri::command]
fn load_note(state: tauri::State<State>, id: String) -> Result<String, String> {
    notes::read(&state.dir, &id)
}

#[tauri::command]
fn save_note(app: AppHandle, state: tauri::State<State>, id: String, content: String) -> Result<(), String> {
    let written = notes::write(&state.dir, &id, &content)?;
    state.written.lock().unwrap().insert(id, written);
    tray::refresh(&app);
    Ok(())
}

/// Adds tasks from the quick capture panel. The folder watcher tells the main window.
#[tauri::command]
fn quick_add(app: AppHandle, state: tauri::State<State>, target: String, tasks: String) -> Result<(), String> {
    let id = if target == notes::BACKLOG { target } else { notes::day_id(0) };
    let markdown = notes::read(&state.dir, &id)?;
    notes::write(&state.dir, &id, &notes::append_tasks(&markdown, &tasks))?;
    tray::refresh(&app);
    Ok(())
}

#[tauri::command]
fn hide_quick(app: AppHandle) {
    quick::hide(&app);
}

#[tauri::command]
fn resize_quick(app: AppHandle, height: f64) {
    quick::resize(&app, height);
}

#[tauri::command]
fn set_capture_shortcut(app: AppHandle, state: tauri::State<State>, shortcut: Option<String>) -> Result<(), String> {
    let mut current = state.shortcut.lock().unwrap();
    *current = quick::set_shortcut(&app, &current, shortcut)?;
    drop(current);
    tray::refresh(&app);
    Ok(())
}

/// Runs blocking work (gh, network, Keychain) off the main thread.
async fn blocking<T: Send + 'static>(app: tauri::AppHandle, work: impl FnOnce(&State) -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<State>())).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn link_info(app: tauri::AppHandle, url: String) -> Result<Option<LinkInfo>, String> {
    blocking(app, move |state| state.links.lookup(&url)).await
}

#[tauri::command]
async fn list_assigned(app: tauri::AppHandle, fresh: bool) -> Result<assigned::Assigned, String> {
    blocking(app, move |state| assigned::fetch(&state.links, fresh)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    notes_dir: String,
    github_login: Option<String>,
    linear: Option<LinearAccount>,
    linear_error: Option<String>,
    cli_path: String,
    cli_installed: bool,
    capture_shortcut: quick::ShortcutStatus,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
}

fn tilde(path: &Path) -> String {
    match path.strip_prefix(home()) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

fn cli_link() -> PathBuf {
    home().join(".local/bin/daybook")
}

#[tauri::command]
async fn get_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    blocking(app, |state| {
        let (linear, linear_error) = match state.links.linear_key().map(|key| links::linear_account(&key)) {
            None => (None, None),
            Some(Ok(account)) => (Some(account), None),
            Some(Err(error)) => (None, Some(error)),
        };
        let exe = std::env::current_exe().ok();
        Settings {
            notes_dir: tilde(&state.dir),
            github_login: links::github_login(),
            linear,
            linear_error,
            cli_path: tilde(&cli_link()),
            cli_installed: exe.is_some() && fs::read_link(cli_link()).ok() == exe,
            capture_shortcut: state.shortcut.lock().unwrap().clone(),
        }
    })
    .await
}

#[tauri::command]
async fn set_linear_key(app: tauri::AppHandle, key: String) -> Result<LinearAccount, String> {
    blocking(app, move |state| state.links.set_linear_key(&key)).await?
}

#[tauri::command]
fn clear_linear_key(state: tauri::State<State>) {
    state.links.clear_linear_key();
}

/// Links ~/.local/bin/daybook to this binary, which is also the CLI.
#[tauri::command]
fn install_cli() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let link = cli_link();
    if let Ok(meta) = fs::symlink_metadata(&link) {
        if !meta.file_type().is_symlink() {
            return Err(format!("{} already exists and isn't a link, so it was left alone.", tilde(&link)));
        }
        fs::remove_file(&link).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(link.parent().unwrap()).map_err(|e| e.to_string())?;
    std::os::unix::fs::symlink(&exe, &link).map_err(|e| e.to_string())?;
    Ok(tilde(&link))
}

#[tauri::command]
fn reveal_notes(state: tauri::State<State>) {
    let _ = std::process::Command::new("open").arg(&state.dir).spawn();
}

/// Called by the page once it has saved, after we asked it to on quit.
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Asks the page to flush its pending save, then quits (or quits anyway after a moment).
fn quit_gracefully(app: &AppHandle) {
    let _ = app.emit_to("main", "daybook://quit", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        app.exit(0);
    });
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The menu bar count follows the date, so check for a new day now and then.
fn watch_date(app: AppHandle) {
    std::thread::spawn(move || {
        let mut today = notes::day_id(0);
        loop {
            std::thread::sleep(Duration::from_secs(30));
            if notes::day_id(0) != today {
                today = notes::day_id(0);
                tray::refresh(&app);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dir = notes::dir();
    fs::create_dir_all(&dir).expect("could not create the notes folder");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&[quick::LABEL]).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_nspanel::init())
        .manage(State {
            dir,
            written: Default::default(),
            links: Links::new(),
            watcher: Mutex::new(None),
            shortcut: Default::default(),
        })
        .setup(|app| {
            let handle = app.handle();
            let state = app.state::<State>();
            match watch::start(handle.clone(), &state.dir, state.written.clone()) {
                Ok(watcher) => *state.watcher.lock().unwrap() = Some(watcher),
                Err(error) => eprintln!("daybook: not watching the notes folder: {error}"),
            }
            quick::create(handle)?;
            *state.shortcut.lock().unwrap() = quick::start(handle);
            tray::create(handle)?;
            watch_date(handle.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_notes,
            load_note,
            save_note,
            quick_add,
            hide_quick,
            resize_quick,
            set_capture_shortcut,
            link_info,
            list_assigned,
            get_settings,
            set_linear_key,
            clear_linear_key,
            install_cli,
            reveal_notes,
            quit
        ])
        // Closing the window hides it, like most Mac apps; the Dock icon brings it back.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building daybook")
        .run(|app, event| match event {
            // Quitting: let the page flush its pending save first.
            RunEvent::ExitRequested { api, code: None, .. } => {
                api.prevent_exit();
                quit_gracefully(app);
            }
            RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
