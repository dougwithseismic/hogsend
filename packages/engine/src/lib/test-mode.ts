import { normalizeRecipients } from "@hogsend/core";
import type { TestModeState } from "./domain-status.js";
import type { Logger } from "./logger.js";

/**
 * Test-mode redirect helpers — the provider-neutral safety net that protects an
 * operator from sending real mail before their DNS verifies. The active
 * {@link TestModeState} is resolved ONCE per send by the mailer (cache-only,
 * zero provider latency) and threaded here; these helpers are pure transforms.
 *
 * Why the redirect lives in the engine (not the provider): any `EmailProvider`
 * is a dumb HTML wire; test mode must protect Postmark/SES users identically.
 * Only `fromOverride` is provider-aware (Resend's `onboarding@resend.dev`), and
 * that knowledge sits in the domain-status resolver, keyed on `providerId`.
 */

/** The structured WARN event name fired per redirected send. */
export const TEST_MODE_REDIRECT_EVENT = "email.test_mode_redirect";

/** The actionable error message when test mode is active but unaddressable. */
export const NO_REDIRECT_MESSAGE =
  "test mode active but no redirect address — set HOGSEND_TEST_EMAIL " +
  "(or STUDIO_ADMIN_EMAIL); the send was BLOCKED, not delivered to the real recipient";

/**
 * Thrown by the no-db raw send paths (`sendRaw`/`sendBatch`) when test mode is
 * active but no redirect address resolves. The tracked (DB) path does NOT throw
 * — it records a `failed` row and returns a skipped result, mirroring the
 * suppression branch — but the raw paths have no row to write, so they fail
 * loudly rather than silently delivering to the real recipient.
 */
export class TestModeNoRedirectError extends Error {
  constructor() {
    super(NO_REDIRECT_MESSAGE);
    this.name = "TestModeNoRedirectError";
  }
}

/** The redirected wire fields for a single message. */
export interface RedirectedFields {
  /** Always the single redirect inbox (cc/bcc are dropped). */
  to: string[];
  /** The single redirect address (`to[0]`), for the `email_sends.toEmail` column. */
  redirectTo: string;
  /** Prefixed `[TEST → <originalRecipients>] <subject>`. */
  subject: string;
  /** `fromOverride ?? originalFrom` (Resend ⇒ onboarding@resend.dev). */
  from: string;
  /** Comma-joined ORIGINAL recipients, for the WARN log + email_sends marker. */
  originalTo: string;
  /** The flattened original recipient list (to + cc + bcc). */
  originalRecipients: string[];
}

/**
 * Resolve the active {@link TestModeState} for a send. Returns the cached state
 * when `active`, else `null` (live send). ALWAYS fires the fire-and-forget
 * `refreshIfStale()` first — the ONLY cache-refresh trigger on the send path,
 * never awaited. `domainStatus` is optional so direct mailer construction
 * (tests) without it keeps today's behavior.
 */
export function resolveTestMode(domainStatus?: {
  testModeCached(): TestModeState;
  refreshIfStale(): void;
}): TestModeState | null {
  if (!domainStatus) return null;
  domainStatus.refreshIfStale();
  const state = domainStatus.testModeCached();
  return state.active ? state : null;
}

/**
 * Build the redirected wire fields for one message under an active test mode.
 * `to`/`cc`/`bcc` flatten into the subject prefix; the wire `to` becomes the
 * single redirect inbox and cc/bcc are dropped entirely (never leak the test
 * mail to an original cc/bcc recipient). Caller MUST have checked
 * `state.redirectTo !== null` first (use {@link isUnaddressable}).
 */
export function buildRedirect(opts: {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  state: TestModeState;
}): RedirectedFields {
  const originalRecipients = [
    ...normalizeRecipients(opts.to),
    ...normalizeRecipients(opts.cc),
    ...normalizeRecipients(opts.bcc),
  ];
  const originalTo = originalRecipients.join(",");
  // redirectTo is non-null here — the caller gates on isUnaddressable first.
  const redirectTo = opts.state.redirectTo as string;
  return {
    to: [redirectTo],
    redirectTo,
    subject: `[TEST → ${originalTo}] ${opts.subject}`,
    from: opts.state.fromOverride ?? opts.from,
    originalTo,
    originalRecipients,
  };
}

/** True when test mode is active but no redirect address resolves. */
export function isUnaddressable(state: TestModeState): boolean {
  return state.active && state.redirectTo === null;
}

/** Fire the per-send structured WARN for a redirected send. */
export function logRedirect(
  logger: Logger | undefined,
  meta: {
    originalTo: string;
    redirectTo: string | null;
    reason: string | null;
  },
): void {
  logger?.warn(TEST_MODE_REDIRECT_EVENT, {
    event: TEST_MODE_REDIRECT_EVENT,
    ...meta,
  });
}
