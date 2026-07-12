import { randomUUID } from "node:crypto";
import type { VoiceProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { contacts, voiceCalls, voiceSuppressions } from "@hogsend/db";
import {
  renderVoiceAgent,
  type VoiceAgentName,
  type VoiceAgentRegistry,
} from "@hogsend/voice";
import { eq } from "drizzle-orm";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
} from "../journeys/journey-boundary.js";
import { logTransition } from "../journeys/journey-log.js";
import { getListRegistry } from "../lists/registry-singleton.js";
import type { FrequencyCapConfig } from "./email-service-types.js";
import { checkJourneySuppress } from "./journey-suppress.js";
import { createLogger, type Logger } from "./logger.js";
import { normalizePhone } from "./phone.js";
import { readRecipientPreferences } from "./preferences.js";
import { isVoiceFrequencyCapped } from "./voice-frequency-cap.js";
import type {
  StartTrackedCallOptions,
  VoiceTrackedResult,
} from "./voice-service-types.js";

const emitLogger = createLogger(process.env.LOG_LEVEL);

/** The engine-synthesized voice channel list id (opt-out polarity). */
export const VOICE_CHANNEL_ID = "voice";

interface TrackedVoiceDeps {
  db: Database;
  provider: VoiceProvider;
  agents: VoiceAgentRegistry;
  providerId?: string;
  defaultFrom?: string;
  frequencyCap?: FrequencyCapConfig;
  logger?: Logger;
  /** Container-wired test-mode resolver (validated env). Absent ⇒ never active. */
  testMode?: () => boolean;
  /** Redirect target while test mode is active (env.HOGSEND_TEST_PHONE). */
  testPhone?: string;
}

/**
 * The result for a keyed call that found an already-DISPATCHED row under its
 * key: any non-`queued` terminal is a satisfied duplicate. Mirrors
 * {@link duplicateResult} in the SMS pipeline.
 */
function duplicateResult(row: {
  id: string;
  status: string;
  providerCallId: string | null;
}): VoiceTrackedResult {
  const started = row.status !== "failed" && row.status !== "queued";
  return {
    voiceCallId: row.id,
    providerCallId: row.providerCallId ?? "",
    status: started ? "started" : "skipped",
  };
}

/**
 * Boundary-aware entry point mirroring {@link sendTrackedSms}. A raw-service call
 * from INSIDE a journey (no idempotency key set) is auto-keyed with the
 * `voiceCall` kind so the engine's exactly-once guarantee covers it. Outside a
 * journey, or with a key already set, this is a transparent pass-through.
 */
export async function sendTrackedVoiceCall<K extends VoiceAgentName>(
  opts: TrackedVoiceDeps & { options: StartTrackedCallOptions<K> },
): Promise<VoiceTrackedResult> {
  const boundary = getJourneyBoundary();
  if (!boundary) return sendTrackedVoiceCallInner(opts);

  const attributed = {
    ...opts,
    options: {
      ...opts.options,
      journeyStateId: opts.options.journeyStateId ?? boundary.stateId,
    },
  };
  if (attributed.options.idempotencyKey) {
    return sendTrackedVoiceCallInner(attributed);
  }

  const site = boundary.currentLabel ?? String(opts.options.agentKey);
  const key = deriveJourneyKey({
    kind: "voiceCall",
    anchor: boundary.runAnchor,
    site,
    discriminant: String(opts.options.agentKey),
  });
  registerKey(boundary, key);
  const keyed = {
    ...attributed,
    options: { ...attributed.options, idempotencyKey: key },
  };
  return boundary.memoize([key], () => sendTrackedVoiceCallInner(keyed));
}

/**
 * Place a tracked voice call. The voice sibling of `sendTrackedSms`: renders the
 * agent, runs the consent/DNC/frequency/journey-suppress/test-mode gates,
 * inserts a `queued` `voice_calls` row, then `provider.startCall` and records the
 * provider call id. No wire body / segments (a call carries a conversation, not
 * text).
 */
async function sendTrackedVoiceCallInner<K extends VoiceAgentName>(
  opts: TrackedVoiceDeps & { options: StartTrackedCallOptions<K> },
): Promise<VoiceTrackedResult> {
  const {
    db,
    provider,
    agents,
    providerId,
    defaultFrom,
    frequencyCap,
    logger,
    options,
  } = opts;

  // Normalize to E.164 ONCE at entry so the DNC exact-match, the stored row, and
  // the provider wire all use the same canonical form (a raw " (555) 123-4567"
  // would slip a suppressed number past the DNC lookup).
  const to = normalizePhone(options.to) ?? options.to;

  // Idempotency short-circuit: a dispatched prior row is a satisfied duplicate;
  // an orphaned `queued` row (crash before startCall recorded a provider id) is
  // re-driven. A `failed` row released its key, so it never collides.
  let reuseRow: { id: string } | undefined;
  if (options.idempotencyKey) {
    const existing = await db
      .select({
        id: voiceCalls.id,
        status: voiceCalls.status,
        providerCallId: voiceCalls.providerCallId,
      })
      .from(voiceCalls)
      .where(eq(voiceCalls.idempotencyKey, options.idempotencyKey))
      .limit(1);
    const prior = existing[0];
    if (prior) {
      if (prior.status === "queued") reuseRow = { id: prior.id };
      else return duplicateResult(prior);
    }
  }

  const { config, category: agentCategory } = renderVoiceAgent({
    key: options.agentKey,
    props: options.props,
    registry: agents,
    variables: options.variables,
  });
  const effectiveCategory = options.category ?? agentCategory;
  const from = options.from ?? defaultFrom;

  // Consent/DNC gate — runs UNCONDITIONALLY; `exempt` (transactional /
  // skipPreferenceCheck) bypasses only the consent + topic gates inside it,
  // never the phone DNC list or unsubscribed_all.
  const exempt =
    options.skipPreferenceCheck === true ||
    effectiveCategory === "transactional";
  const suppression = await checkVoiceSuppression(db, {
    phone: to,
    userId: options.userId,
    category: effectiveCategory,
    exempt,
  });
  if (suppression) {
    const rows = await db
      .insert(voiceCalls)
      .values({
        agentKey: String(options.agentKey),
        providerId,
        fromNumber: from,
        toNumber: to,
        direction: "outbound",
        journeyStateId: options.journeyStateId,
        userId: options.userId,
        status: "failed",
        metadata: { suppressionReason: suppression },
        // A suppressed call does NOT consume the idempotency key — a later retry
        // after a grant / DNC removal can then actually place the call.
      })
      .returning({ id: voiceCalls.id });
    const row = rows[0];
    if (!row) throw new Error("Failed to insert voice_calls row");
    return {
      voiceCallId: row.id,
      providerCallId: "",
      status:
        suppression === "no_consent"
          ? "no_consent"
          : suppression === "unsubscribed" || suppression === "channel_off"
            ? "unsubscribed"
            : "suppressed",
    };
  }

  if (!options.skipPreferenceCheck) {
    if (frequencyCap) {
      const capped = await isVoiceFrequencyCapped({
        db,
        to: to,
        category: options.category,
        config: frequencyCap,
      });
      if (capped) {
        logger?.info("voice call skipped: frequency_capped", {
          to: to,
        });
        return {
          voiceCallId: "",
          providerCallId: "",
          status: "skipped",
          reason: "frequency_capped",
        };
      }
    }

    const boundary = getJourneyBoundary();
    const suppress = await checkJourneySuppress({
      db,
      boundary,
      to: to,
      idempotencyKey: options.idempotencyKey,
      channel: "voice",
    });
    if (suppress.suppressed) {
      logger?.info("voice call skipped: journey_suppressed", {
        to: to,
        journeyId: boundary?.journeyId,
      });
      return {
        voiceCallId: "",
        providerCallId: "",
        status: "skipped",
        reason: "journey_suppressed",
      };
    }

    // Calling-hours guard (TCPA 8am–9pm RECIPIENT-LOCAL). Enforced when the
    // recipient's timezone is resolvable from the contact; skipped (allowed) when
    // it isn't, since a wrong-tz guess could wrongly block a legitimate call —
    // operators wanting a hard guard set the contact `timezone` property or use
    // `ctx.when` to schedule.
    if (await isOutsideCallingHours({ db, userId: options.userId })) {
      logger?.info("voice call skipped: quiet_hours", { to });
      return {
        voiceCallId: "",
        providerCallId: "",
        status: "skipped",
        reason: "quiet_hours",
      };
    }
  }

  // Test mode: redirect the call to HOGSEND_TEST_PHONE (block when unset).
  // Consent checks above stayed keyed to the ORIGINAL recipient.
  const testActive = opts.testMode?.() ?? false;
  const testPhone = opts.testPhone;
  if (testActive && !testPhone) {
    (logger ?? emitLogger).error(
      "Voice test mode active but HOGSEND_TEST_PHONE is unset; call blocked",
      { originalTo: to, agentKey: String(options.agentKey) },
    );
    const rows = await db
      .insert(voiceCalls)
      .values({
        agentKey: String(options.agentKey),
        providerId,
        fromNumber: from,
        toNumber: to,
        direction: "outbound",
        journeyStateId: options.journeyStateId,
        userId: options.userId,
        status: "failed",
        metadata: { testMode: true, originalTo: to },
      })
      .returning({ id: voiceCalls.id });
    return {
      voiceCallId: rows[0]?.id ?? "",
      providerCallId: "",
      status: "skipped",
      reason: "test_mode_blocked",
    };
  }
  const wireTo = testActive && testPhone ? testPhone : to;

  // Persist the agent's allowed tool names (the mid-call dispatcher authorizes
  // tool calls against this) + the call variables (hydrated into tool context) +
  // any test-mode annotation. One metadata object, written with the queued row.
  const callMetadata: Record<string, unknown> = {
    allowedTools: config.tools?.map((t) => t.name) ?? [],
    ...(options.variables ? { variables: options.variables } : {}),
    ...(testActive && testPhone ? { testMode: true, originalTo: to } : {}),
  };

  // Insert the queued row (reuse an orphaned one on replay), race-safe on the
  // idempotency key: the INSERT conflict LOSER adopts the winner's row.
  let voiceCallId: string;
  if (reuseRow) {
    voiceCallId = reuseRow.id;
  } else {
    const rowId = randomUUID();
    const baseInsert = db.insert(voiceCalls).values({
      id: rowId,
      agentKey: String(options.agentKey),
      providerId,
      fromNumber: from,
      toNumber: wireTo,
      direction: "outbound",
      journeyStateId: options.journeyStateId,
      userId: options.userId,
      status: "queued",
      idempotencyKey: options.idempotencyKey,
      metadata: callMetadata,
    });
    const insertRows = options.idempotencyKey
      ? await baseInsert
          .onConflictDoNothing({ target: voiceCalls.idempotencyKey })
          .returning({ id: voiceCalls.id })
      : await baseInsert.returning({ id: voiceCalls.id });
    if (insertRows[0]) {
      voiceCallId = insertRows[0].id;
    } else {
      // Idempotency-key loser: adopt the winner.
      const winner = await db
        .select({
          id: voiceCalls.id,
          status: voiceCalls.status,
          providerCallId: voiceCalls.providerCallId,
        })
        .from(voiceCalls)
        .where(eq(voiceCalls.idempotencyKey, options.idempotencyKey ?? ""))
        .limit(1);
      const won = winner[0];
      if (!won) throw new Error("Failed to insert voice_calls row");
      // The idempotency-key LOSER must NOT place a second call — the WINNER owns
      // `provider.startCall` for this key. Return the winner's row and stop here
      // (falling through to startCall below is exactly the double-dial bug).
      return won.status !== "queued"
        ? duplicateResult(won)
        : {
            voiceCallId: won.id,
            providerCallId: won.providerCallId ?? "",
            status: "started",
          };
    }
  }

  try {
    const result = await provider.startCall({
      to: wireTo,
      ...(from ? { from } : {}),
      agent: config,
      ...(options.variables ? { variables: options.variables } : {}),
      metadata: { voiceCallId },
    });

    const startedAt = new Date();
    await db
      .update(voiceCalls)
      .set({
        providerCallId: result.id,
        status: "ringing",
        startedAt,
        updatedAt: startedAt,
      })
      .where(eq(voiceCalls.id, voiceCallId));

    if (options.journeyStateId) {
      logTransition({
        db,
        journeyStateId: options.journeyStateId,
        to: `voice:${String(options.agentKey)}`,
        action: "send",
        detail: { agent: String(options.agentKey), voiceCallId },
      });
    }

    // No journey-bus emit for call_started: the journey that placed the call is
    // already running and waits on the terminal `voice.call_ended` (ingested by
    // the webhook route). External webhook subscription for voice.* is a
    // deferred follow-up (needs the outbound catalog + vendored copies).
    return { voiceCallId, providerCallId: result.id, status: "started" };
  } catch (error) {
    // startCall failed. Stamp `failed` AND release the idempotency key so a
    // retry genuinely re-attempts (mirrors the SMS pipeline).
    await db
      .update(voiceCalls)
      .set({ status: "failed", idempotencyKey: null, updatedAt: new Date() })
      .where(eq(voiceCalls.id, voiceCallId));
    throw error;
  }
}

/** TCPA telemarketing window: no calls before 8am or at/after 9pm local. */
const CALLING_HOUR_START = 8;
const CALLING_HOUR_END = 21;

/**
 * True when the recipient's LOCAL time is outside the 8am–9pm TCPA window. The
 * timezone is read from the contact's `timezone` property; with no resolvable tz
 * (or no `userId`) this returns false (allow) — a wrong-tz guess must not block a
 * legitimate call, and there is no safe default local time for an unknown number.
 */
async function isOutsideCallingHours(opts: {
  db: Database;
  userId?: string;
}): Promise<boolean> {
  if (!opts.userId) return false;
  let tz: string | undefined;
  try {
    const rows = await opts.db
      .select({ properties: contacts.properties })
      .from(contacts)
      .where(eq(contacts.externalId, opts.userId))
      .limit(1);
    const props = (rows[0]?.properties ?? {}) as { timezone?: unknown };
    tz = typeof props.timezone === "string" ? props.timezone : undefined;
  } catch {
    return false;
  }
  if (!tz) return false;
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        hour12: false,
      }).format(new Date()),
    );
  } catch {
    return false; // invalid tz string — don't block
  }
  if (Number.isNaN(hour)) return false;
  // Intl can render midnight as "24"; normalize to 0.
  const local = hour === 24 ? 0 : hour;
  return local < CALLING_HOUR_START || local >= CALLING_HOUR_END;
}

type VoiceSuppressionReason =
  | "suppressed"
  | "unsubscribed"
  | "channel_off"
  | "no_consent"
  | null;

/**
 * Resolve whether a voice call to `phone` must be suppressed. Voice marketing is
 * the STRICTEST-regulated channel (TCPA prior express WRITTEN consent + DNC), so
 * the gate is explicit opt-in and there is NO phone-number-implies-consent track
 * (unlike SMS, where texting START is itself consent):
 *
 *  1. Voice DNC (`voice_suppressions`, ANY row is an active block, checked
 *     UNCONDITIONALLY — `exempt` never bypasses it).
 *  2. `unsubscribed_all` on the contact's `email_preferences` — also never
 *     bypassed.
 *  3. `exempt` (transactional / skipPreferenceCheck) short-circuits ONLY the
 *     consent + topic gates below this point.
 *  4. The `voice` channel gate: an explicit `categories.voice === false` blocks;
 *     otherwise the call needs an explicit `categories.voice === true` grant
 *     (the channel registers `defaultOptIn: false`). A call with no resolvable
 *     `userId` fails CLOSED (`no_consent`).
 *  5. The topic-category gate.
 */
async function checkVoiceSuppression(
  db: Database,
  opts: {
    phone: string;
    userId?: string;
    category?: string;
    exempt?: boolean;
  },
): Promise<VoiceSuppressionReason> {
  const dncRows = await db
    .select({ id: voiceSuppressions.id })
    .from(voiceSuppressions)
    .where(eq(voiceSuppressions.phone, opts.phone))
    .limit(1);
  if (dncRows[0]) return "suppressed";

  const prefs = opts.userId
    ? await readRecipientPreferences(db, { userId: opts.userId })
    : null;
  if (prefs?.unsubscribedAll) return "unsubscribed";

  if (opts.exempt) return null;

  const registry = getListRegistry();
  if (prefs?.categories[VOICE_CHANNEL_ID] === false) return "channel_off";
  const granted =
    prefs != null && registry.isSubscribed(prefs.categories, VOICE_CHANNEL_ID);
  if (!granted) return "no_consent";

  if (
    opts.category &&
    prefs &&
    !registry.isSubscribed(prefs.categories, opts.category)
  ) {
    return "unsubscribed";
  }
  return null;
}
