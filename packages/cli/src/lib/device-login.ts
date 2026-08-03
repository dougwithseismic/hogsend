import type { CloudClient } from "./cloud-http.js";
import { CloudError } from "./cloud-http.js";

/**
 * The testable half of `hogsend login`: mint a device code, tell the human what
 * to type, and wait.
 *
 * Every side effect — HTTP, the browser, the clock, the sleep, the printing —
 * is injected, so the whole flow (approval, denial, expiry, a slow-down, a
 * refused mint) is exercised with no network and no wall-clock wait. That is
 * the pattern `connect-flow.ts` set for `hogsend connect posthog`.
 *
 * THE PHISHING BOUNDARY, which shapes this file more than anything else: the
 * mint response deliberately carries a BARE verification URL, never one with
 * the user code prefilled (RFC 8628 §5.4 — `apps/cli/device/route.ts` states
 * the reasoning at length). What changed, deliberately: the URL this file
 * OPENS carries `?code=` so the approve page can prefill it. That is a small,
 * bounded trade — the link never leaves this machine (it goes straight from
 * this process to this machine's browser, so there is no stranger to phish),
 * the code is short-lived and single-use, and it approves nothing without the
 * signed-in dashboard session that confirms it. The SERVER still never pairs
 * a URL with a code: a link that can be forwarded must stay bare. The code
 * and the bare URL are always printed too, so the flow never depends on a
 * browser existing: if opening fails, nothing is lost, because what matters
 * was on screen either way.
 *
 * TOKEN HYGIENE INVARIANT: the approved token is RETURNED, never printed. No
 * `emit` call in this file receives it, and no error message carries it.
 */

/** `POST /api/cli/device` — the mint response. */
export interface DeviceMintResponse {
  deviceCode: string;
  userCode: string;
  /** Bare, never prefilled. */
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

/** `POST /api/cli/device/poll` — one answer. */
export type DevicePollResponse =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "denied" }
  | {
      status: "approved";
      token: string;
      sessionId: string;
      organizationId: string;
      userId: string;
    };

export type DeviceLoginFailure =
  | "mint_failed"
  | "rate_limited"
  | "denied"
  | "expired"
  | "timeout";

export class DeviceLoginError extends Error {
  readonly verdict: DeviceLoginFailure;
  readonly hint: string | undefined;

  constructor(verdict: DeviceLoginFailure, message: string, hint?: string) {
    super(message);
    this.name = "DeviceLoginError";
    this.verdict = verdict;
    this.hint = hint;
  }
}

export interface DeviceLoginDeps {
  client: CloudClient;
  /** Best-effort browser open. Returns false rather than throwing. */
  openBrowser(url: string): boolean;
  /** Human-facing output. NEVER receives the token. */
  emit(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface DeviceLoginOptions {
  /** The machine name sent as the session label. */
  label: string;
  /** Skip the browser open (`--no-browser`, or any non-interactive run). */
  noBrowser?: boolean;
  /**
   * Hard ceiling on the wait, independent of the server's `expiresIn`. The
   * server's expiry is authoritative; this is the guard against a server that
   * answers `pending` forever.
   */
  maxWaitMs?: number;
}

export interface DeviceLoginResult {
  token: string;
  sessionId: string;
  organizationId: string;
  userId: string;
  userCode: string;
  verificationUrl: string;
}

/** The floor on the poll cadence, whatever the server suggests. */
const MIN_INTERVAL_MS = 1_000;
/** And the ceiling, so a bad `interval` cannot strand a terminal for an hour. */
const MAX_INTERVAL_MS = 30_000;
/** The default hard ceiling: comfortably past the server's 15-minute expiry. */
const DEFAULT_MAX_WAIT_MS = 16 * 60_000;

function clampInterval(seconds: unknown): number {
  const ms =
    typeof seconds === "number" && Number.isFinite(seconds)
      ? seconds * 1000
      : 5_000;
  return Math.min(Math.max(ms, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}

/**
 * Run the device flow to a verdict.
 *
 * Rate limiting during the WAIT is not a failure: the cloud's poll limiter
 * answers 429 with a `retry-after`, and the correct response is to honour it
 * and keep waiting — a login abandoned because another machine behind the same
 * NAT was polling would be a worse bug than a slow one. A 429 on the MINT is
 * different: nothing has started yet, and there is nothing to be patient about.
 */
export async function runDeviceLogin(
  options: DeviceLoginOptions,
  deps: DeviceLoginDeps,
): Promise<DeviceLoginResult> {
  let minted: DeviceMintResponse;
  try {
    minted = await deps.client.post<DeviceMintResponse>("/api/cli/device", {
      label: options.label,
    });
  } catch (error) {
    if (error instanceof CloudError && error.status === 429) {
      throw new DeviceLoginError(
        "rate_limited",
        "Too many login attempts from this address.",
        error.retryAfter
          ? `Try again in about ${error.retryAfter}s.`
          : "Try again shortly.",
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new DeviceLoginError(
      "mint_failed",
      `Could not start a login against ${deps.client.baseUrl}: ${detail}`,
    );
  }

  // What the human acts on, before any attempt to be clever with a browser.
  deps.emit("");
  deps.emit(`  Your code:  ${minted.userCode}`);
  deps.emit(`  Open:       ${minted.verificationUrl}`);
  deps.emit("");
  deps.emit("  Type the code on that page to approve this machine.");
  deps.emit("");

  if (!options.noBrowser) {
    // The OPENED url carries the code so the page can prefill it — safe only
    // because this link goes from this process to this machine's own browser
    // and nowhere else. The PRINTED url above stays bare. See the module note.
    const approveUrl = new URL(minted.verificationUrl);
    approveUrl.searchParams.set("code", minted.userCode);
    const opened = deps.openBrowser(approveUrl.toString());
    if (!opened) {
      deps.emit("  (couldn't open your browser — open the URL above yourself)");
    }
  }

  const started = deps.now();
  const deadline = started + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  let interval = clampInterval(minted.interval);

  for (;;) {
    await deps.sleep(interval);

    if (deps.now() >= deadline) {
      throw new DeviceLoginError(
        "timeout",
        "Timed out waiting for approval.",
        "Run `hogsend login` again when you are at the browser.",
      );
    }

    let answer: DevicePollResponse;
    try {
      answer = await deps.client.post<DevicePollResponse>(
        "/api/cli/device/poll",
        { deviceCode: minted.deviceCode },
      );
    } catch (error) {
      if (error instanceof CloudError && error.status === 429) {
        // Back off to whatever the cloud asked for, then keep waiting.
        interval = clampInterval(error.retryAfter ?? interval / 1000);
        continue;
      }
      if (error instanceof CloudError && error.status === 0) {
        // A transient network blip must not throw away a pending approval the
        // human may be about to give. Keep polling until the deadline.
        continue;
      }
      throw error;
    }

    if (answer.status === "approved") {
      return {
        token: answer.token,
        sessionId: answer.sessionId,
        organizationId: answer.organizationId,
        userId: answer.userId,
        userCode: minted.userCode,
        verificationUrl: minted.verificationUrl,
      };
    }
    if (answer.status === "denied") {
      throw new DeviceLoginError(
        "denied",
        "That login was denied in the dashboard.",
      );
    }
    if (answer.status === "expired") {
      // The cloud answers `expired` for an unknown code, a lapsed one, AND an
      // approval somebody already collected — deliberately indistinguishable.
      throw new DeviceLoginError(
        "expired",
        "That login code expired before it was approved.",
        "Run `hogsend login` again.",
      );
    }
    // pending — keep waiting.
  }
}
