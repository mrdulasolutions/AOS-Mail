// AOS Mail — Tauri 2 shell.
//
// Responsibilities:
//   - native window with macOS vibrancy + traffic-light positioning
//   - native menu bar (Mac standard shortcuts)
//   - Keychain-backed secret storage (via tauri-plugin-store + Apple Security framework)
//   - spawn + supervise the Node sidecar binary that runs the heavy backend
//   - forward `invoke` calls from the renderer to the sidecar via JSON-RPC
//
// The sidecar holds Gmail/IMAP sync, the Claude agent stack, SQLite — anything
// that benefits from Node's mature ecosystem. Tauri owns the OS surface only.

use tauri::Manager;

mod sidecar;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::default().build())
        .setup(|app| {
            // Spawn the Node sidecar that runs the email/agent backend.
            let handle = sidecar::SidecarHandle::spawn(app.handle().clone())?;
            app.manage(handle);

            // Window polish: macOS vibrancy, fallback no-op elsewhere.
            if let Some(window) = app.get_webview_window("main") {
                apply_macos_vibrancy(&window)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ping, sidecar_request])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
