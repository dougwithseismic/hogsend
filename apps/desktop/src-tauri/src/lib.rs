//! Hogsend companion backend.
//!
//! Owns a single background poller that hits `${baseUrl}/v1/health` on the
//! active connection, mirrors the result to the tray (title + tooltip), emits
//! it to the UI (`health://update`), and raises a native notification when a
//! new failure appears. Fetching lives here (not the webview) so it sidesteps
//! CORS and keeps running while the window is hidden.

use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const POLL_INTERVAL: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const TRAY_ID: &str = "main";
/// Keychain service name; the per-instance base URL is the account key.
const KEYCHAIN_SERVICE: &str = "com.hogsend.desktop";

// Server-contract paths the companion depends on — a hand-mirror of the
// engine's routes. The guard test
// `apps/api/src/__tests__/desktop-companion-contract.test.ts` fails if any of
// these moves; keep the two in sync.
const HEALTH_PATH: &str = "/v1/health";
const STUDIO_PATH: &str = "/studio";
const AUTH_BASE: &str = "/api/auth";

/// Result of one health fetch. Serialized to the UI as-is; field names match
/// `src/lib/types.ts` (`Snapshot`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    base_url: String,
    fetched_at: u64,
    ok: bool,
    health: Option<Value>,
    error: Option<String>,
}

/// Minimal failure fingerprint used to decide whether to notify. Derived from
/// the raw health JSON so it survives schema additions.
#[derive(Clone, Default, PartialEq)]
struct FailureState {
    email_failed: i64,
    journey_failed: i64,
    worker_down: bool,
    unhealthy: bool,
}

#[derive(Default)]
struct AppState {
    /// Active connection base URL, or `None` when idle.
    active: Mutex<Option<String>>,
    /// Most recent snapshot (for `get_snapshot`).
    last: Mutex<Option<Snapshot>>,
    /// Last failure fingerprint, for notification de-duplication.
    failures: Mutex<Option<FailureState>>,
}

struct Http(reqwest::Client);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read a possibly-null integer count from the health JSON.
fn count_at(health: &Value, pointer: &str) -> i64 {
    health.pointer(pointer).and_then(Value::as_i64).unwrap_or(0)
}

fn fingerprint(health: &Value) -> FailureState {
    let status = health.get("status").and_then(Value::as_str).unwrap_or("");
    let worker = health
        .pointer("/components/worker/status")
        .and_then(Value::as_str)
        .unwrap_or("up");
    FailureState {
        email_failed: count_at(health, "/activity/emails/failed"),
        journey_failed: count_at(health, "/activity/journeys/failed"),
        worker_down: worker == "down",
        unhealthy: status != "healthy",
    }
}

/// Compact one-line summary shown in the menu bar.
fn tray_title(snap: &Snapshot) -> String {
    if !snap.ok {
        return "🔴".to_string();
    }
    let Some(health) = &snap.health else {
        return "⚪".to_string();
    };
    let status = health.get("status").and_then(Value::as_str).unwrap_or("");
    let fp = fingerprint(health);
    let glyph = match status {
        "healthy" if !fp.worker_down => "🟢",
        "migration_pending" => "🟡",
        _ => "🔴",
    };
    let failed = fp.email_failed + fp.journey_failed;
    if failed > 0 {
        format!("{glyph} {failed}")
    } else {
        glyph.to_string()
    }
}

fn tray_tooltip(snap: &Snapshot) -> String {
    if !snap.ok {
        return format!(
            "{}\nUnreachable: {}",
            snap.base_url,
            snap.error.as_deref().unwrap_or("unknown error")
        );
    }
    let Some(health) = &snap.health else {
        return snap.base_url.clone();
    };
    let status = health.get("status").and_then(Value::as_str).unwrap_or("?");
    format!(
        "{}\nStatus: {}\nSent {}h: {} · Failed: {}",
        snap.base_url,
        status,
        count_at(health, "/activity/windowHours"),
        count_at(health, "/activity/emails/sent"),
        count_at(health, "/activity/emails/failed"),
    )
}

async fn fetch_snapshot(client: &reqwest::Client, base_url: &str) -> Snapshot {
    let url = format!("{base_url}{HEALTH_PATH}");
    let fetched_at = now_ms();
    match client.get(&url).timeout(REQUEST_TIMEOUT).send().await {
        Ok(resp) => {
            let status = resp.status();
            match resp.json::<Value>().await {
                Ok(body) if status.is_success() => Snapshot {
                    base_url: base_url.to_string(),
                    fetched_at,
                    ok: true,
                    health: Some(body),
                    error: None,
                },
                Ok(_) => Snapshot {
                    base_url: base_url.to_string(),
                    fetched_at,
                    ok: false,
                    health: None,
                    error: Some(format!("HTTP {}", status.as_u16())),
                },
                Err(err) => Snapshot {
                    base_url: base_url.to_string(),
                    fetched_at,
                    ok: false,
                    health: None,
                    error: Some(format!("Bad response: {err}")),
                },
            }
        }
        Err(err) => Snapshot {
            base_url: base_url.to_string(),
            fetched_at,
            ok: false,
            health: None,
            error: Some(err.to_string()),
        },
    }
}

/// Compare the new health against the last fingerprint and notify on any
/// newly-appeared failure. Updates the stored fingerprint in place.
fn maybe_notify(app: &AppHandle, snap: &Snapshot) {
    let Some(health) = snap.health.as_ref().filter(|_| snap.ok) else {
        return;
    };
    let next = fingerprint(health);
    let state = app.state::<AppState>();
    let prev = state.failures.lock().unwrap().clone();
    *state.failures.lock().unwrap() = Some(next.clone());

    let Some(prev) = prev else {
        // First sample for this connection — seed the baseline silently.
        return;
    };

    let mut lines: Vec<String> = Vec::new();
    if next.email_failed > prev.email_failed {
        lines.push(format!(
            "{} email send(s) failed",
            next.email_failed - prev.email_failed
        ));
    }
    if next.journey_failed > prev.journey_failed {
        lines.push(format!(
            "{} journey run(s) failed",
            next.journey_failed - prev.journey_failed
        ));
    }
    if next.worker_down && !prev.worker_down {
        lines.push("Worker went offline".to_string());
    }
    if next.unhealthy && !prev.unhealthy {
        lines.push("Instance is no longer healthy".to_string());
    }

    if lines.is_empty() {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("Hogsend")
        .body(lines.join("\n"))
        .show();
}

fn update_tray(app: &AppHandle, snap: &Snapshot) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(tray_title(snap)));
        let _ = tray.set_tooltip(Some(tray_tooltip(snap).as_str()));
    }
}

/// Fetch the active connection once, then fan the result out to state, tray,
/// notifications, and the UI. Returns `None` when no connection is active.
async fn poll_once(app: &AppHandle) -> Option<Snapshot> {
    let base_url = app.state::<AppState>().active.lock().unwrap().clone()?;
    let client = app.state::<Http>().0.clone();
    let snap = fetch_snapshot(&client, &base_url).await;

    // The active connection may have changed while the request was in flight.
    let state = app.state::<AppState>();
    {
        let active = state.active.lock().unwrap();
        if active.as_deref() != Some(snap.base_url.as_str()) {
            return None;
        }
    }

    *state.last.lock().unwrap() = Some(snap.clone());
    update_tray(app, &snap);
    maybe_notify(app, &snap);
    let _ = app.emit("health://update", &snap);
    Some(snap)
}

#[tauri::command]
fn set_active_connection(app: AppHandle, base_url: Option<String>) {
    {
        let state = app.state::<AppState>();
        *state.active.lock().unwrap() = base_url.clone();
        // New connection → forget the old failure baseline so we don't
        // misattribute its counts to the new instance.
        *state.failures.lock().unwrap() = None;
        *state.last.lock().unwrap() = None;
    }
    if base_url.is_some() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            poll_once(&app).await;
        });
    } else if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some("⚪"));
        let _ = tray.set_tooltip(Some("No instance selected"));
    }
}

#[tauri::command]
fn get_snapshot(app: AppHandle) -> Option<Snapshot> {
    app.state::<AppState>().last.lock().unwrap().clone()
}

#[tauri::command]
async fn fetch_health_now(app: AppHandle) -> Result<Snapshot, String> {
    poll_once(&app)
        .await
        .ok_or_else(|| "No active connection".to_string())
}

// --- Auto-login credentials (OS keychain) --------------------------------

#[derive(Serialize, Deserialize)]
struct StoredCreds {
    email: String,
    password: String,
}

fn creds_entry(base_url: &str) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, base_url).map_err(|e| e.to_string())
}

fn read_creds(base_url: &str) -> Option<StoredCreds> {
    let raw = creds_entry(base_url).ok()?.get_password().ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
fn save_credentials(base_url: String, email: String, password: String) -> Result<(), String> {
    let payload =
        serde_json::to_string(&StoredCreds { email, password }).map_err(|e| e.to_string())?;
    creds_entry(&base_url)?
        .set_password(&payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_credentials(base_url: String) -> Result<(), String> {
    match creds_entry(&base_url)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn credentials_email(base_url: String) -> Option<String> {
    read_creds(&base_url).map(|c| c.email)
}

/// Same-origin auto-login injected into the Studio webview. Runs on every load
/// of the instance origin: if there's no session yet, it signs in once with the
/// stored credentials and reloads. Credentials are JSON-encoded into JS string
/// literals (injection-safe), and the script no-ops on any other origin.
fn auto_login_script(origin: &str, creds: &StoredCreds) -> String {
    let origin_js = serde_json::to_string(origin).unwrap_or_else(|_| "\"\"".into());
    let email_js = serde_json::to_string(&creds.email).unwrap_or_else(|_| "\"\"".into());
    let pw_js = serde_json::to_string(&creds.password).unwrap_or_else(|_| "\"\"".into());
    // Trusted ASCII constants, inlined directly into the JS string literals.
    let auth = AUTH_BASE;
    let studio = STUDIO_PATH;
    format!(
        r#"(function(){{
  try {{
    // Top frame only + exact-origin match: never run inside an iframe or on
    // any origin other than the configured instance.
    if (window.top !== window.self) return;
    var BASE = {origin_js};
    if (location.origin !== BASE) return;
    if (sessionStorage.getItem("hs_autologin")) return;
    fetch(BASE + "{auth}/get-session", {{ credentials: "include", headers: {{ accept: "application/json" }} }})
      .then(function(r) {{ return r.ok ? r.json() : null; }})
      .then(function(s) {{
        if (s && s.user) return;
        sessionStorage.setItem("hs_autologin", "1");
        return fetch(BASE + "{auth}/sign-in/email", {{
          method: "POST",
          credentials: "include",
          headers: {{ "content-type": "application/json" }},
          body: JSON.stringify({{ email: {email_js}, password: {pw_js}, rememberMe: true }})
        }}).then(function(r) {{ if (r.ok) location.replace(BASE + "{studio}/"); }});
      }})
      .catch(function() {{}});
  }} catch (e) {{}}
}})();"#
    )
}

/// One Studio window per instance origin. Using a per-origin label (instead of
/// a single "studio" label we destroy+recreate) sidesteps the Tauri
/// `WindowLabelAlreadyExists` race — `destroy()` is asynchronous on the event
/// loop, so an immediate same-label rebuild often fails. Each instance keeps
/// its own window (and its own auto-login), and switching just reuses/creates.
fn studio_label(origin: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    origin.hash(&mut hasher);
    format!("studio-{:x}", hasher.finish())
}

/// Auto-login may only run where credentials can't be sniffed in transit:
/// https anywhere, or http on loopback (where there is no network hop).
fn is_secure_for_credentials(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        || matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("::1")
        )
}

#[tauri::command]
fn open_studio(app: AppHandle, base_url: String) -> Result<(), String> {
    let trimmed = base_url.trim_end_matches('/');
    let parsed =
        tauri::Url::parse(&format!("{trimmed}{STUDIO_PATH}")).map_err(|e| e.to_string())?;
    let origin = parsed.origin().ascii_serialization();
    let label = studio_label(&origin);

    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let secure = is_secure_for_credentials(&parsed);
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title("Hogsend Studio")
        .inner_size(1100.0, 800.0)
        .min_inner_size(720.0, 540.0);

    // Never inject credentials over a plaintext (non-loopback) origin.
    if secure {
        if let Some(creds) = read_creds(trimmed) {
            builder = builder.initialization_script(&auto_login_script(&origin, &creds));
        }
    }

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

// --- Auto-update (Tauri updater + GitHub Releases feed) ------------------

/// Check the updater endpoint; if a newer build exists, download, install, and
/// restart into it. The restart diverges, so a successful apply never returns;
/// `Ok(false)` means already current.
async fn run_update(app: &AppHandle) -> Result<bool, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    Ok(updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .map(|u| u.version))
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    run_update(&app).await.map(|_| ())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .user_agent(concat!("hogsend-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("failed to build HTTP client");

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .manage(Http(http))
        .invoke_handler(tauri::generate_handler![
            set_active_connection,
            get_snapshot,
            fetch_health_now,
            open_studio,
            save_credentials,
            clear_credentials,
            credentials_email,
            check_for_updates,
            install_update,
        ])
        .setup(|app| {
            // Companion app: live in the menu bar, not the Dock.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let _ = app.notification().request_permission();

            let menu = MenuBuilder::new(app)
                .item(&MenuItemBuilder::with_id("open", "Open Hogsend").build(app)?)
                .item(&MenuItemBuilder::with_id("studio", "Open Studio").build(app)?)
                .item(&MenuItemBuilder::with_id("refresh", "Refresh now").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("update", "Check for Updates…").build(app)?)
                .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?)
                .build()?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .title("⚪")
                .tooltip("Hogsend — no instance selected")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "studio" => {
                        if let Some(base) = app.state::<AppState>().active.lock().unwrap().clone() {
                            let _ = open_studio(app.clone(), base);
                        } else {
                            show_main(app);
                        }
                    }
                    "refresh" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            poll_once(&app).await;
                        });
                    }
                    "update" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            match run_update(&app).await {
                                // Update applied → process restarts, never here.
                                Ok(true) => {}
                                Ok(false) => {
                                    notify(&app, "Hogsend", "You're on the latest version.");
                                }
                                Err(e) => notify(&app, "Update check failed", &e),
                            }
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        show_main(&tray.app_handle().clone());
                    }
                })
                .build(app)?;

            // Background poller: ticks every POLL_INTERVAL and no-ops while idle.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    poll_once(&handle).await;
                }
            });

            // Quiet update check on launch — notify only; the user applies it
            // from the tray (no surprise restart). Errors (unreachable feed,
            // bad manifest/signature) are logged, never silently swallowed —
            // otherwise a broken update feed is invisible.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match handle.updater() {
                    Ok(updater) => match updater.check().await {
                        Ok(Some(update)) => notify(
                            &handle,
                            "Update available",
                            &format!(
                                "Hogsend {} is ready — tray menu → Check for Updates to install.",
                                update.version
                            ),
                        ),
                        Ok(None) => {}
                        Err(e) => eprintln!("[hogsend] update check failed: {e}"),
                    },
                    Err(e) => eprintln!("[hogsend] updater unavailable: {e}"),
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hogsend desktop");
}
