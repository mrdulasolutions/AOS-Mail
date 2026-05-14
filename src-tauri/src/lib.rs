// AOS Mail — Tauri 2 shell.
//
// Responsibilities:
//   - native window with macOS vibrancy + traffic-light positioning
//   - native menu bar (Mac standard shortcuts)
//   - Keychain-backed secret storage (via tauri-plugin-store + Apple Security framework)
//   - spawn + supervise the Node sidecar binary that runs the heavy backend
//   - forward `invoke` calls from the renderer to the sidecar via JSON-RPC
//   - dock badge + native notifications + mailto:// URL handling (Mac polish)
//
// The sidecar holds Gmail/IMAP sync, the Claude agent stack, SQLite — anything
// that benefits from Node's mature ecosystem. Tauri owns the OS surface only.

use tauri::{Emitter, Manager};

mod keychain;
mod menu;
mod sidecar;

#[cfg(target_os = "macos")]
mod mac_polish;

#[cfg(target_os = "macos")]
mod native_notifications;

#[cfg(target_os = "macos")]
fn apply_macos_vibrancy(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
    let _ = apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        None,
    );
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn apply_macos_vibrancy(_window: &tauri::WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
async fn sidecar_request(
    state: tauri::State<'_, sidecar::SidecarHandle>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.request(&method, params).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn ping() -> &'static str {
    "AOS Mail shell alive"
}

/// Sets the dock-tile badge to the given unread count. `count == 0` clears
/// the badge. We use Tauri 2's built-in `set_badge_count` (calls
/// `NSApp.dockTile.setBadgeLabel:` under the hood on macOS), which means we
/// don't need to thread cocoa calls through `run_on_main_thread` ourselves —
/// the runtime already does that.
#[tauri::command]
fn set_dock_badge(window: tauri::Window, count: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Cap at i64::MAX defensively; Tauri's setter takes Option<i64>.
        let value: Option<i64> = if count == 0 { None } else { Some(count as i64) };
        window.set_badge_count(value).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, count);
        Ok(())
    }
}

/// Brings the main window to the front. Used by notification click handlers
/// so that clicking a notification both focuses the app and routes a
/// thread-selection event to the renderer.
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Registers AOS Mail as the system handler for the given URL scheme
/// (typically "mailto"). Returns Ok on success. Works in unsigned dev builds —
/// macOS just won't keep the binding across rebuilds because each rebuild has
/// a different code-signing identity.
#[tauri::command]
fn set_default_mail_app(make_default: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        mac_polish::set_default_handler(make_default).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = make_default;
        Ok(false)
    }
}

/// Reports whether AOS Mail is currently registered as the default mailto://
/// handler. Used by Settings to keep the toggle in sync with the OS state.
#[tauri::command]
fn is_default_mail_app() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(mac_polish::is_default_handler())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

/// Returns the most recent mailto:// URL the OS handed us at cold start
/// (consumed once). The renderer subscribes to live `mailto:open` events for
/// warm starts and calls this on mount to drain anything that arrived before
/// the listener was attached.
#[tauri::command]
fn get_pending_mailto(
    state: tauri::State<'_, MailtoQueue>,
) -> Result<Option<serde_json::Value>, String> {
    Ok(state.take())
}

/// Prompt the user for notification permission via UNUserNotificationCenter,
/// the modern macOS framework. We route around tauri-plugin-notification
/// because its underlying notify-rust uses the deprecated
/// NSUserNotificationCenter, which on Sequoia delivers to Notification
/// Center but doesn't show banners. Returns the resolved state — on every
/// call after the first one, macOS doesn't re-prompt and we get back the
/// cached decision.
#[tauri::command]
fn notify_request_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        native_notifications::request_authorization()
            .map(|s| serde_json::to_value(s).unwrap_or_default())
            .map(|v| v.as_str().unwrap_or("not_determined").to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("denied".to_string())
    }
}

/// Query the live notification permission state without prompting. Used by
/// the renderer's permission probe at boot and by Settings to keep the
/// toggle's visible state in sync if the user changed the system setting
/// while the app was running.
#[tauri::command]
fn notify_permission_state() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        native_notifications::authorization_state()
            .map(|s| serde_json::to_value(s).unwrap_or_default())
            .map(|v| v.as_str().unwrap_or("not_determined").to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok("denied".to_string())
    }
}

/// Deliver a notification with the given title + body. macOS handles all the
/// chrome (icon, sound, banner timing) based on per-app System Settings.
#[tauri::command]
fn notify_send(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        native_notifications::send(&title, &body)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (title, body);
        Ok(())
    }
}

/// In-memory mailto queue. Holds ONE pending parsed URL — that's all macOS
/// needs at cold start; subsequent mailto opens come through the live event
/// channel and are already routed to the renderer by the time they arrive.
struct MailtoQueue {
    inner: std::sync::Mutex<Option<serde_json::Value>>,
}

impl MailtoQueue {
    fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(None),
        }
    }

    fn store(&self, value: serde_json::Value) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some(value);
        }
    }

    fn take(&self) -> Option<serde_json::Value> {
        self.inner.lock().ok().and_then(|mut guard| guard.take())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::default().build())
        // Updater plugin — registered so `@tauri-apps/plugin-updater` from
        // the renderer can call check()/downloadAndInstall(). Endpoint is
        // configured in tauri.conf.json with `active: false` until signing
        // keys land in Phase 5; the surface is in place either way.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Spawn the Node sidecar that runs the email/agent backend.
            let handle = sidecar::SidecarHandle::spawn(app.handle().clone())?;
            app.manage(handle);

            // Cold-start mailto buffer (filled by RunEvent::Opened, drained
            // by the renderer's getPending call on mount).
            app.manage(MailtoQueue::new());

            // Native menu bar — standard Mac chrome with custom IDs that
            // emit Tauri events the renderer subscribes to.
            let menu_bar = menu::build_menu(app)?;
            app.set_menu(menu_bar)?;

            // Window polish: macOS vibrancy, fallback no-op elsewhere.
            if let Some(window) = app.get_webview_window("main") {
                apply_macos_vibrancy(&window)?;
            }
            Ok(())
        })
        .on_menu_event(menu::handle_menu_event)
        .invoke_handler(tauri::generate_handler![
            ping,
            sidecar_request,
            set_dock_badge,
            focus_main_window,
            set_default_mail_app,
            is_default_mail_app,
            get_pending_mailto,
            notify_request_permission,
            notify_permission_state,
            notify_send,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // We use `.build()` + `.run(callback)` (rather than the shorthand
    // `.run(context)`) so we can observe `RunEvent::Opened` and route
    // mailto:// URLs the OS hands us at launch into the renderer.
    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            for url in urls {
                if let Some(parsed) = parse_mailto(url.as_str()) {
                    // Always cache the latest one as a "pending" pickup —
                    // covers the cold-start race where the renderer hasn't
                    // attached its listener yet.
                    if let Some(queue) = app_handle.try_state::<MailtoQueue>() {
                        queue.store(parsed.clone());
                    }
                    // And emit live for warm starts. The renderer is free to
                    // ignore duplicate IDs if both fire.
                    let _ = app_handle.emit("mailto:open", parsed);
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
        }
        let _ = (app_handle, event);
    });
}

/// Parses a mailto:// URL into the JSON shape the renderer's compose flow
/// expects (`{ to, cc, bcc, subject, body }`). Tolerates malformed URLs by
/// returning None — we never want a bad incoming URL to crash the app loop.
#[cfg(target_os = "macos")]
fn parse_mailto(raw: &str) -> Option<serde_json::Value> {
    use serde_json::json;

    if !raw.starts_with("mailto:") && !raw.starts_with("MAILTO:") {
        return None;
    }
    // Strip "mailto:" — case-insensitive prefix.
    let body = &raw[7..];
    // Split on '?' to separate the recipient list from the query parameters.
    let (recipient_str, query_str) = match body.find('?') {
        Some(i) => (&body[..i], &body[i + 1..]),
        None => (body, ""),
    };

    let mut to: Vec<String> = Vec::new();
    let mut cc: Vec<String> = Vec::new();
    let mut bcc: Vec<String> = Vec::new();
    let mut subject = String::new();
    let mut body_text = String::new();

    if !recipient_str.is_empty() {
        for addr in recipient_str.split(',') {
            let decoded = url_decode(addr.trim());
            if !decoded.is_empty() {
                to.push(decoded);
            }
        }
    }

    for pair in query_str.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.find('=') {
            Some(i) => (&pair[..i], &pair[i + 1..]),
            None => (pair, ""),
        };
        let key = url_decode(k).to_ascii_lowercase();
        let value = url_decode(v);
        match key.as_str() {
            "to" => {
                for addr in value.split(',') {
                    let s = addr.trim().to_string();
                    if !s.is_empty() {
                        to.push(s);
                    }
                }
            }
            "cc" => {
                for addr in value.split(',') {
                    let s = addr.trim().to_string();
                    if !s.is_empty() {
                        cc.push(s);
                    }
                }
            }
            "bcc" => {
                for addr in value.split(',') {
                    let s = addr.trim().to_string();
                    if !s.is_empty() {
                        bcc.push(s);
                    }
                }
            }
            "subject" => subject = value,
            "body" => body_text = value,
            _ => {}
        }
    }

    Some(json!({
        "to": to,
        "cc": cc,
        "bcc": bcc,
        "subject": subject,
        "body": body_text,
    }))
}

/// Bare-bones percent-decoding for mailto query strings. Replaces "+" with
/// space (RFC 2368 follows form-encoded conventions), and decodes %XX bytes.
/// Invalid escapes pass through unchanged, matching browser behavior.
#[cfg(target_os = "macos")]
fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
