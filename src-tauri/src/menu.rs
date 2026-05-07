// Native macOS menu bar.
//
// Builds a standard Mac menu (Apple, AOS Mail, File, Edit, View, Mailbox,
// Window, Help). Each custom item gets a stable ID; on click the Rust
// shell forwards a Tauri event named "menu:<id>" to the renderer, which
// hooks into the existing keyboard-shortcut handlers.
//
// Predefined items (about, hide, services, copy/paste, undo, quit) are
// the OS-supplied implementations — they behave correctly without any
// extra wiring.

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{App, AppHandle, Emitter, Manager, Runtime, Wry};

pub fn build_menu(app: &App) -> tauri::Result<Menu<Wry>> {
    let handle = app.handle();

    // ── AOS Mail (application) menu ──
    let app_submenu = Submenu::with_items(
        handle,
        "AOS Mail",
        true,
        &[
            &PredefinedMenuItem::about(handle, Some("About AOS Mail"), None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "settings", "Settings…", true, Some("Cmd+,"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    // ── File ──
    let file_submenu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &MenuItem::with_id(handle, "new-message", "New Message", true, Some("Cmd+N"))?,
            &MenuItem::with_id(
                handle,
                "new-window",
                "New Window",
                true,
                Some("Cmd+Shift+N"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "save-draft", "Save Draft", true, Some("Cmd+S"))?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(
                handle,
                "import-superhuman",
                "Import from Superhuman…",
                true,
                None::<&str>,
            )?,
        ],
    )?;

    // ── Edit ──
    let edit_submenu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "find", "Find…", true, Some("Cmd+F"))?,
        ],
    )?;

    // ── View ──
    let view_submenu = Submenu::with_items(
        handle,
        "View",
        true,
        &[
            &MenuItem::with_id(
                handle,
                "toggle-sidebar",
                "Toggle Sidebar",
                true,
                Some("Cmd+\\"),
            )?,
            &MenuItem::with_id(
                handle,
                "command-palette",
                "Command Palette…",
                true,
                Some("Cmd+K"),
            )?,
            &MenuItem::with_id(
                handle,
                "agent-palette",
                "Agent Palette…",
                true,
                Some("Cmd+J"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::fullscreen(handle, None)?,
        ],
    )?;

    // ── Mailbox ──
    let mailbox_submenu = Submenu::with_items(
        handle,
        "Mailbox",
        true,
        &[
            &MenuItem::with_id(
                handle,
                "get-new-mail",
                "Get New Mail",
                true,
                Some("Cmd+Shift+M"),
            )?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "reply", "Reply", true, Some("Cmd+R"))?,
            &MenuItem::with_id(
                handle,
                "reply-all",
                "Reply All",
                true,
                Some("Cmd+Shift+R"),
            )?,
            &MenuItem::with_id(handle, "forward", "Forward", true, Some("Cmd+Shift+F"))?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "archive", "Archive", true, Some("E"))?,
            &MenuItem::with_id(handle, "trash", "Move to Trash", true, Some("Backspace"))?,
            &MenuItem::with_id(handle, "snooze", "Snooze…", true, Some("H"))?,
            &MenuItem::with_id(handle, "star", "Star", true, Some("S"))?,
            &MenuItem::with_id(handle, "mark-unread", "Mark as Unread", true, Some("U"))?,
        ],
    )?;

    // ── Window ──
    let window_submenu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
        ],
    )?;

    // ── Help ──
    let help_submenu = Submenu::with_items(
        handle,
        "Help",
        true,
        &[
            &MenuItem::with_id(
                handle,
                "report-bug",
                "Report a Bug…",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                handle,
                "open-data-folder",
                "Open Data Folder",
                true,
                None::<&str>,
            )?,
        ],
    )?;

    Menu::with_items(
        handle,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &mailbox_submenu,
            &window_submenu,
            &help_submenu,
        ],
    )
}

/// Forwards menu events to the renderer as Tauri events under
/// "menu:<id>". The renderer subscribes via bridge.listen("menu:reply"),
/// etc., and routes to the existing keyboard-shortcut handlers.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    let _ = app.emit(&format!("menu:{}", id), serde_json::Value::Null);
    // Also focus the main window when a menu item fires — mirrors the
    // typical Mac app behavior where File→New brings the window forward.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_focus();
    }
}
