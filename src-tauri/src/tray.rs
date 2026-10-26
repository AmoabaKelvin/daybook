//! The menu bar icon: today's open count next to it, and a menu to tick tasks off,
//! capture something new, or open the app.

use crate::{notes, quick, State};
use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

const ID: &str = "daybook";
const MAX_TASKS: usize = 12;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(ID)
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Daybook")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(app)?;
    refresh(app);
    Ok(())
}

/// Rebuilds the count and menu from today's note on disk.
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(ID) else { return };
    let state = app.state::<State>();
    let markdown = notes::read(&state.dir, &notes::day_id(0)).unwrap_or_default();
    let open: Vec<notes::Task> = notes::tasks(&markdown).into_iter().filter(|t| !t.done && !t.moved).collect();
    let _ = tray.set_title((!open.is_empty()).then(|| open.len().to_string()));
    let shortcut = state.shortcut.lock().unwrap().shortcut.clone();
    if let Ok(menu) = menu(app, &open, shortcut.as_deref()) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn menu(app: &AppHandle, open: &[notes::Task], shortcut: Option<&str>) -> tauri::Result<Menu<Wry>> {
    let heading = match open.len() {
        0 => "Nothing open today".to_string(),
        1 => "Today · 1 open".to_string(),
        n => format!("Today · {n} open"),
    };
    let mut menu = MenuBuilder::new(app).item(&MenuItemBuilder::new(heading).enabled(false).build(app)?);
    for task in open.iter().take(MAX_TASKS) {
        let text = format!("{}{}", "    ".repeat(task.depth), plain(&task.text));
        menu = menu.item(&CheckMenuItemBuilder::with_id(format!("task:{}", task.line), text).checked(false).build(app)?);
    }
    if open.len() > MAX_TASKS {
        menu = menu.item(&MenuItemBuilder::new(format!("{} more…", open.len() - MAX_TASKS)).enabled(false).build(app)?);
    }
    let mut capture = MenuItemBuilder::with_id("capture", "Quick Capture…");
    if let Some(shortcut) = shortcut {
        capture = capture.accelerator(shortcut);
    }
    menu.separator()
        .item(&capture.build(app)?)
        .item(&MenuItemBuilder::with_id("open", "Open Daybook").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit Daybook").build(app)?)
        .build()
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "capture" => quick::toggle(app),
        "open" => crate::show_main(app),
        "quit" => crate::quit_gracefully(app),
        _ => {
            if let Some(line) = id.strip_prefix("task:").and_then(|l| l.parse().ok()) {
                tick(app, line);
            }
        }
    }
}

/// Ticks a task off in today's note. The folder watcher tells the window.
fn tick(app: &AppHandle, line: usize) {
    let state = app.state::<State>();
    let id = notes::day_id(0);
    if let Ok(markdown) = notes::read(&state.dir, &id) {
        let _ = notes::write(&state.dir, &id, &notes::set_done(&markdown, line, true));
    }
    refresh(app);
}

/// A task's text without markdown: link text instead of links, no emphasis marks.
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('[') {
        let Some(mid) = rest[start..].find("](").map(|i| start + i) else { break };
        let Some(end) = rest[mid..].find(')').map(|i| mid + i) else { break };
        out.push_str(&rest[..start]);
        out.push_str(&rest[start + 1..mid]);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    let out: String = out.replace("**", "").replace("~~", "").replace('`', "");
    let out = out.trim();
    if out.chars().count() > 56 {
        format!("{}…", out.chars().take(55).collect::<String>().trim_end())
    } else {
        out.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::plain;

    #[test]
    fn plain_text_from_markdown() {
        assert_eq!(plain("Review [fix: the thing](https://github.com/a/b/pull/1) **today**"), "Review fix: the thing today");
        assert_eq!(plain("no links"), "no links");
        assert_eq!(plain("[a](x) and [b](y)"), "a and b");
        assert_eq!(plain("broken [link"), "broken [link");
    }
}
