import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Snapshot } from "./types";

/**
 * Thin typed wrapper over the Rust commands and events. The Rust side owns the
 * polling loop, the tray, and notifications; the UI drives it through these
 * calls and reflects whatever the poller emits.
 */

/** Point the poller at a base URL (or `null` to idle). Triggers an immediate fetch. */
export function setActiveConnection(baseUrl: string | null): Promise<void> {
  return invoke("set_active_connection", { baseUrl });
}

/** Latest cached snapshot for the active connection, if any. */
export function getSnapshot(): Promise<Snapshot | null> {
  return invoke("get_snapshot");
}

/** Force an immediate fetch of the active connection and return the result. */
export function fetchHealthNow(): Promise<Snapshot> {
  return invoke("fetch_health_now");
}

/**
 * Open the real Studio (`${baseUrl}/studio`) in a dedicated webview window.
 * If auto-login credentials are stored for the instance, the window signs
 * itself in (same-origin) when no session is present.
 */
export function openStudio(baseUrl: string): Promise<void> {
  return invoke("open_studio", { baseUrl });
}

/**
 * Persist auto-login credentials for an instance in the OS keychain. The
 * password never returns to the UI after this call.
 */
export function saveCredentials(
  baseUrl: string,
  email: string,
  password: string,
): Promise<void> {
  return invoke("save_credentials", { baseUrl, email, password });
}

/** Remove stored auto-login credentials for an instance. */
export function clearCredentials(baseUrl: string): Promise<void> {
  return invoke("clear_credentials", { baseUrl });
}

/** The stored auto-login email for an instance, or `null` if none is saved. */
export function credentialsEmail(baseUrl: string): Promise<string | null> {
  return invoke("credentials_email", { baseUrl });
}

/** Subscribe to poller updates. Returns an unlisten function. */
export function onHealthUpdate(
  cb: (snapshot: Snapshot) => void,
): Promise<UnlistenFn> {
  return listen<Snapshot>("health://update", (event) => cb(event.payload));
}
