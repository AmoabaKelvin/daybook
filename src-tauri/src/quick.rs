//! Quick capture: a global shortcut opens a small floating box over whatever app you're in.
//! It's a non-activating panel, so the app you were in stays in front and gets focus back.

use crate::prefs;
use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Size, WebviewUrl};
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub const LABEL: &str = "quick";
/// The card is 600 wide; the rest is room for its shadow.
const WIDTH: f64 = 660.0;

tauri_panel! {
    panel!(QuickPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })

    panel_event!(QuickPanelEvents {
        window_did_resign_key(notification: &NSNotification) -> ()
    })
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let panel = PanelBuilder::<_, QuickPanel>::new(app, LABEL)
        .url(WebviewUrl::App("index.html".into()))
        .size(Size::Logical(LogicalSize::new(WIDTH, 160.0)))
        .level(PanelLevel::ModalPanel)
        .transparent(true)
        .has_shadow(false)
        .hides_on_deactivate(false)
        .add_style_mask(StyleMask::empty().nonactivating_panel())
        .collection_behavior(CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().ignores_cycle())
        .title("Quick Capture")
        .with_window(|w| w.decorations(false).transparent(true).visible(false).resizable(false).skip_taskbar(true))
        .no_activate(true)
        .build()?;

    // Clicking anywhere else dismisses it, like Spotlight. The page animates out, then hides it.
    let events = QuickPanelEvents::new();
    let handle = app.clone();
    events.window_did_resign_key(move |_| {
        let _ = handle.emit_to(LABEL, "daybook://quick-blur", ());
    });
    panel.set_event_handler(Some(events.as_ref()));
    Ok(())
}

pub fn toggle(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(panel) = handle.get_webview_panel(LABEL) else { return };
        if panel.is_visible() {
            return panel.hide();
        }
        place(&handle);
        let _ = handle.emit_to(LABEL, "daybook://quick-open", ());
        panel.show_and_make_key();
    });
}

pub fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = handle.get_webview_panel(LABEL) {
            panel.hide();
        }
    });
}

/// The panel grows with its rows; the page reports its height.
pub fn resize(app: &AppHandle, height: f64) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.set_size(LogicalSize::new(WIDTH, height.clamp(60.0, 640.0)));
    }
}

/// Centred near the top of the screen the pointer is on.
fn place(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    let _ = window.set_position(LogicalPosition::new(origin.x + (size.width - WIDTH) / 2.0, origin.y + size.height * 0.2));
}

/// The current shortcut, and why it couldn't be registered if it couldn't.
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub shortcut: Option<String>,
    pub error: Option<String>,
}

fn register(app: &AppHandle, shortcut: Option<&str>) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    let _ = shortcuts.unregister_all();
    let Some(shortcut) = shortcut else { return Ok(()) };
    shortcuts
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .map_err(|e| format!("Couldn't use {shortcut}: {e}. Another app may already use it."))
}

/// Registers the saved shortcut at launch.
pub fn start(app: &AppHandle) -> ShortcutStatus {
    let shortcut = prefs::load().capture_shortcut;
    let error = register(app, shortcut.as_deref()).err();
    ShortcutStatus { shortcut, error }
}

/// Switches to a new shortcut, keeping the old one if the new one can't be registered.
pub fn set_shortcut(app: &AppHandle, current: &ShortcutStatus, shortcut: Option<String>) -> Result<ShortcutStatus, String> {
    if let Err(error) = register(app, shortcut.as_deref()) {
        let _ = register(app, current.shortcut.as_deref());
        return Err(error);
    }
    prefs::update(|p| p.capture_shortcut = shortcut.clone())?;
    Ok(ShortcutStatus { shortcut, error: None })
}
