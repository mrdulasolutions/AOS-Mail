// macOS polish: LaunchServices integration.
//
// Tauri 2's window-level `set_badge_count` already covers the dock-tile badge
// (see lib.rs::set_dock_badge), so this module is dedicated to the one piece
// the framework doesn't expose: registering AOS Mail as the system handler
// for the `mailto://` URL scheme.
//
// The Apple-supplied API is `LSSetDefaultHandlerForURLScheme` /
// `LSCopyDefaultHandlerForURLScheme`. They take CFString arguments, so we use
// `core-foundation` for the safe wrapper types and declare an `extern "C"`
// block to bind the two C symbols themselves (`core-foundation` doesn't
// expose LaunchServices). The `link` attribute pulls the framework into the
// final binary at link time.
//
// Important: in dev mode Apple identifies the bundle by its on-disk path —
// every cargo rebuild gets a fresh signature, so the binding doesn't survive
// rebuilds. That's expected. In a packaged signed/notarized build, the
// binding sticks until the user changes it via System Settings.

use core_foundation::base::TCFType;
use core_foundation::string::{CFString, CFStringRef};

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSSetDefaultHandlerForURLScheme(
        in_url_scheme: CFStringRef,
        in_handler_bundle_id: CFStringRef,
    ) -> i32; // OSStatus
    fn LSCopyDefaultHandlerForURLScheme(in_url_scheme: CFStringRef) -> CFStringRef;
}

const MAILTO_SCHEME: &str = "mailto";
const AOS_MAIL_BUNDLE_ID: &str = "com.mrdulasolutions.aosmail";

/// Sets or clears AOS Mail as the default mailto:// handler.
///
/// When `make_default` is true we register our bundle ID. When false we
/// re-register Apple's stock Mail.app (`com.apple.mail`) — the LaunchServices
/// API doesn't have a "no handler" state, so the cleanest "off" semantics is
/// to hand the scheme back to the system default.
pub fn set_default_handler(make_default: bool) -> Result<bool, String> {
    let scheme = CFString::new(MAILTO_SCHEME);
    let target = if make_default {
        CFString::new(AOS_MAIL_BUNDLE_ID)
    } else {
        CFString::new("com.apple.mail")
    };

    let status = unsafe {
        LSSetDefaultHandlerForURLScheme(
            scheme.as_concrete_TypeRef(),
            target.as_concrete_TypeRef(),
        )
    };

    if status != 0 {
        // OSStatus codes are signed 32-bit; surface the raw value so a caller
        // can grep Console.app or look it up in CoreServices headers.
        return Err(format!("LSSetDefaultHandlerForURLScheme failed: {status}"));
    }

    // Re-read state from the OS rather than trusting our optimistic view of
    // it — gives the renderer a consistent answer on the round trip.
    Ok(is_default_handler() == make_default)
}

/// Returns true iff the OS currently routes mailto:// to AOS Mail.
pub fn is_default_handler() -> bool {
    let scheme = CFString::new(MAILTO_SCHEME);
    let raw = unsafe { LSCopyDefaultHandlerForURLScheme(scheme.as_concrete_TypeRef()) };
    if raw.is_null() {
        return false;
    }
    // SAFETY: LSCopyDefaultHandlerForURLScheme returns a CFStringRef with +1
    // retain count; wrap_under_create_rule transfers ownership and frees on
    // drop. Comparing UTF-8 case-insensitively because bundle IDs are
    // canonical-lowercase but third-party tools sometimes register mixed-case.
    let bundle_id = unsafe { CFString::wrap_under_create_rule(raw) };
    bundle_id.to_string().eq_ignore_ascii_case(AOS_MAIL_BUNDLE_ID)
}
