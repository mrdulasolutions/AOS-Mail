// macOS-only: UNUserNotificationCenter wrapper that replaces
// tauri-plugin-notification on this platform.
//
// Why this exists:
//   tauri-plugin-notification → notify-rust → mac-notification-sys all use
//   NSUserNotificationCenter, which Apple deprecated in macOS 10.14. On
//   Sequoia (and progressively on earlier modern macOS), notifications via
//   that API still reach Notification Center but no longer pop as banners —
//   Apple's slow-roll deprecation behavior. Every native Mac app users
//   recognize (Mail, Slack, Things, Linear) is on UNUserNotificationCenter.
//   The fix is to talk to UN ourselves; no upstream plugin migration is
//   needed.
//
// What's wired up:
//   - request_authorization()    →  request alert+sound+badge permission
//   - authorization_state()      →  query current state without prompting
//   - send(title, body)          →  deliver a notification immediately
//
// What's NOT wired up (deferred to a follow-up):
//   - delegate for foreground willPresent / didReceive callbacks
//     (background banners pop with no delegate; foreground notifications go
//      to NC silently — that's the UN default and is fine for v1)
//   - rich content, attachments, actions, threadIdentifier
//   - per-notification click → thread routing (the renderer used to do this
//     via plugin-notification's onAction; UN's didReceiveResponse is the
//     equivalent and lands in v2)
//
// The dev-mode caveat:
//   UNUserNotificationCenter requires the calling process to be a valid
//   .app bundle. `tauri dev` wraps the binary into one, so this works,
//   but the bundle identifier the OS resolves is derived from the dev
//   build path — different from production. Notification settings the
//   user grants to the dev build do not transfer to the installed app.

#![cfg(target_os = "macos")]

use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
    UNNotificationRequest, UNNotificationSettings, UNUserNotificationCenter,
};
use serde::Serialize;

/// Plain-text shape we hand back across the JS bridge.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    NotDetermined,
    Denied,
    Authorized,
    Provisional,
    Ephemeral,
}

impl From<UNAuthorizationStatus> for AuthState {
    fn from(s: UNAuthorizationStatus) -> Self {
        match s {
            UNAuthorizationStatus::NotDetermined => AuthState::NotDetermined,
            UNAuthorizationStatus::Denied => AuthState::Denied,
            UNAuthorizationStatus::Authorized => AuthState::Authorized,
            UNAuthorizationStatus::Provisional => AuthState::Provisional,
            UNAuthorizationStatus::Ephemeral => AuthState::Ephemeral,
            _ => AuthState::NotDetermined,
        }
    }
}

/// Prompt the user (once, then no-op on subsequent calls — macOS caches
/// the decision). Returns the resulting state.
///
/// Blocks the calling thread on a mpsc channel until UN's completion
/// handler fires. Tauri runs each sync command on a worker thread, so
/// this doesn't stall the tokio runtime or the main thread.
pub fn request_authorization() -> Result<AuthState, String> {
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let options =
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let tx_clone = tx.clone();
    let handler = RcBlock::new(move |_granted: Bool, error: *mut NSError| {
        let result = if error.is_null() {
            Ok(())
        } else {
            let err = unsafe { Retained::retain(error) };
            let msg = err
                .map(|e| e.localizedDescription().to_string())
                .unwrap_or_else(|| "unknown UN error".to_string());
            Err(msg)
        };
        let _ = tx_clone.send(result);
    });

    center.requestAuthorizationWithOptions_completionHandler(options, &handler);
    drop(tx);

    rx.recv()
        .map_err(|e| format!("UN auth completion never fired: {e}"))??;

    // Authorization granted/denied is reflected in the live settings; query
    // those to avoid lying about Provisional vs Authorized.
    authorization_state()
}

/// Query state without prompting.
pub fn authorization_state() -> Result<AuthState, String> {
    let center = UNUserNotificationCenter::currentNotificationCenter();

    let (tx, rx) = mpsc::channel::<AuthState>();
    let tx_clone = tx.clone();
    let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // UN guarantees non-null on this callback; the `NonNull` wrapper in
        // the generated bindings is what enforces it.
        let state = unsafe { settings.as_ref().authorizationStatus() }.into();
        let _ = tx_clone.send(state);
    });

    center.getNotificationSettingsWithCompletionHandler(&handler);
    drop(tx);

    rx.recv()
        .map_err(|e| format!("UN settings completion never fired: {e}"))
}

/// Deliver a notification immediately. No trigger → UN fires it as soon as
/// the request is accepted. Banners pop when the app is backgrounded.
/// Foreground delivery goes to Notification Center silently until we wire
/// up a willPresent delegate (deferred).
pub fn send(title: &str, body: &str) -> Result<(), String> {
    let center = UNUserNotificationCenter::currentNotificationCenter();

    let content = UNMutableNotificationContent::new();
    let title_ns = NSString::from_str(title);
    let body_ns = NSString::from_str(body);
    content.setTitle(&title_ns);
    content.setBody(&body_ns);

    // UN requires a unique non-empty identifier per request. Same ID
    // replaces a delivered notification, which is fine — we want fresh
    // notifications, not deduped ones, so the timestamp + nanos suffices.
    let id_str = format!("aos-mail-{}", monotonic_nanos());
    let id_ns = NSString::from_str(&id_str);

    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&id_ns, &content, None);

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let tx_clone = tx.clone();
    let handler = RcBlock::new(move |error: *mut NSError| {
        let result = if error.is_null() {
            Ok(())
        } else {
            let err = unsafe { Retained::retain(error) };
            let msg = err
                .map(|e| e.localizedDescription().to_string())
                .unwrap_or_else(|| "unknown UN error".to_string());
            Err(msg)
        };
        let _ = tx_clone.send(result);
    });

    center.addNotificationRequest_withCompletionHandler(&request, Some(&handler));
    drop(tx);

    rx.recv()
        .map_err(|e| format!("UN add completion never fired: {e}"))?
}

fn monotonic_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}
