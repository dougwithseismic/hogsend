import type {
  VoiceAgentConfig,
  VoiceAssistantRequest,
  VoiceEvent,
  VoiceEventType,
  VoiceProvider,
  VoiceToolCall,
  VoiceToolResult,
  VoiceWebhookHandlerMap,
} from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { voiceCalls, voiceSuppressions } from "@hogsend/db";
import { renderVoiceAgent, type VoiceAgentName } from "@hogsend/voice";
import { and, eq, inArray } from "drizzle-orm";
import { hatchet } from "./hatchet.js";
import { createLogger } from "./logger.js";
import { emitOutbound } from "./outbound.js";
import { normalizePhone } from "./phone.js";
import type {
  StartTrackedCallOptions,
  VoiceIngestDescriptor,
  VoiceService,
  VoiceServiceConfig,
  VoiceServiceWebhookResult,
  VoiceTrackedResult,
} from "./voice-service-types.js";
import { dispatchVoiceToolCalls } from "./voice-tools.js";
import { sendTrackedVoiceCall } from "./voice-tracked.js";

const emitLogger = createLogger(process.env.LOG_LEVEL);

type VoiceCallStatus =
  | "queued"
  | "ringing"
  | "in_progress"
  | "completed"
  | "no_answer"
  | "voicemail"
  | "failed";

/**
 * Voice event → the terminal `voice_calls` status it sets, plus the statuses it
 * may LEGALLY transition from. Provider webhooks are unordered HTTP requests, so
 * the status advance is guarded monotonic. But — unlike SMS — the JOURNEY-BUS
 * ingest does NOT gate on the advance: the row is resolved and ingested on EVERY
 * terminal callback (deduped by an idempotency key), so a retry after a crash
 * that already advanced the status still wakes the waiting journey.
 */
const WEBHOOK_TO_VOICE_STATUS: Partial<
  Record<
    VoiceEventType,
    { status: VoiceCallStatus; allowedFrom: VoiceCallStatus[] }
  >
> = {
  "voice.call_started": { status: "ringing", allowedFrom: ["queued"] },
  "voice.call_ended": {
    status: "completed",
    allowedFrom: ["queued", "ringing", "in_progress"],
  },
  "voice.no_answer": {
    status: "no_answer",
    allowedFrom: ["queued", "ringing"],
  },
  "voice.voicemail": {
    status: "voicemail",
    allowedFrom: ["queued", "ringing"],
  },
  "voice.failed": {
    status: "failed",
    allowedFrom: ["queued", "ringing", "in_progress"],
  },
};

const TERMINAL_EVENTS = new Set<VoiceEventType>([
  "voice.call_ended",
  "voice.no_answer",
  "voice.voicemail",
  "voice.failed",
]);

interface CallRowCtx {
  voiceCallId: string;
  agentKey: string | null;
  userId: string | null;
  toNumber: string;
}

/**
 * The engine-owned high-level voice caller. Owns the pipeline — agent synthesis
 * → consent/DNC → `voice_calls` insert → `provider.startCall` → status record —
 * plus mid-call tool dispatch and terminal-outcome persistence. Delegates only
 * raw call placement + webhook parse/verify to the injected {@link VoiceProvider}.
 * The voice sibling of `createTrackedSmsSender`.
 */
export function createTrackedVoiceCaller(
  config: VoiceServiceConfig,
  deps: { provider: VoiceProvider },
): VoiceService {
  const { provider } = deps;
  const db = config.db as Database | undefined;
  const logger = config.logger ?? emitLogger;
  const providerId = config.providerId;

  const service: VoiceService = {
    async startCall<K extends VoiceAgentName>(
      options: StartTrackedCallOptions<K>,
    ): Promise<VoiceTrackedResult> {
      if (!db) {
        throw new Error(
          "Voice calls require a database — createHogsendClient wires it.",
        );
      }
      return sendTrackedVoiceCall({
        db,
        provider,
        agents: config.agents,
        providerId: config.providerId,
        defaultFrom: config.defaultFrom,
        frequencyCap: config.frequencyCap,
        logger: config.logger,
        testMode: config.testMode,
        testPhone: config.testPhone,
        options,
      });
    },

    async dispatchToolCalls(
      calls: VoiceToolCall[],
    ): Promise<VoiceToolResult[]> {
      return dispatchVoiceToolCalls({
        db,
        providerId,
        calls,
        tools: config.tools ?? {},
        logger,
      });
    },

    async handleAssistantRequest(
      request: VoiceAssistantRequest,
    ): Promise<VoiceAgentConfig | null> {
      const agentKey = config.inboundAgent;
      if (!agentKey) return null; // no inbound agent configured → decline
      const { config: agentConfig } = renderVoiceAgent({
        key: agentKey,
        props: (config.inboundProps ?? {}) as never,
        registry: config.agents,
      });
      // Create the inbound row so terminal/tool webhooks have a row to resolve.
      // `to_number` holds the OTHER party (the caller) per the column's
      // outbound-callee semantics; `from_number` is the number they dialed.
      if (db) {
        const caller = normalizePhone(request.caller) ?? request.caller;
        await db
          .insert(voiceCalls)
          .values({
            agentKey: String(agentKey),
            providerId,
            providerCallId: request.callId,
            direction: "inbound",
            fromNumber: request.called,
            toNumber: caller,
            status: "ringing",
            startedAt: new Date(),
            metadata: {
              allowedTools: agentConfig.tools?.map((t) => t.name) ?? [],
            },
          })
          .onConflictDoNothing()
          .catch((err: unknown) => {
            logger.warn("inbound voice_calls insert failed", {
              callId: request.callId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }
      return agentConfig;
    },

    async recordOptOut(
      phone: string,
      o?: { reason?: string; source?: string },
    ): Promise<void> {
      if (!db) return;
      const normalized = normalizePhone(phone) ?? phone;
      if (!normalized) return;
      const now = new Date();
      const reason = o?.reason ?? "opt_out";
      await db
        .insert(voiceSuppressions)
        .values({
          phone: normalized,
          reason,
          source: o?.source ?? "tool",
          suppressedAt: now,
        })
        .onConflictDoUpdate({
          target: voiceSuppressions.phone,
          set: { reason, suppressedAt: now, updatedAt: now },
        });
    },

    async handleWebhook(
      event: VoiceEvent,
      webhookProviderId?: string,
    ): Promise<VoiceServiceWebhookResult> {
      const ingest = await dispatchVoiceWebhook(event, webhookProviderId);
      const userHandlers: VoiceWebhookHandlerMap = config.webhookHandlers ?? {};
      const userHandler = userHandlers[event.type] as
        | ((e: VoiceEvent) => void | Promise<void>)
        | undefined;
      let handled = false;
      if (userHandler) {
        await userHandler(event);
        handled = true;
      }
      return {
        type: event.type,
        handled,
        ...(ingest.length ? { ingest } : {}),
      };
    },
  };

  /** Resolve the call row, scoped to the webhook's provider (no cross-provider
   * call-id collision). Independent of whether THIS callback advances status. */
  async function resolveRow(
    event: VoiceEvent,
    webhookProviderId?: string,
  ): Promise<CallRowCtx | null> {
    if (!db || !event.callId) return null;
    const pid = webhookProviderId ?? providerId;
    const where = pid
      ? and(
          eq(voiceCalls.providerCallId, event.callId),
          eq(voiceCalls.providerId, pid),
        )
      : eq(voiceCalls.providerCallId, event.callId);
    const rows = await db
      .select({
        voiceCallId: voiceCalls.id,
        agentKey: voiceCalls.agentKey,
        userId: voiceCalls.userId,
        toNumber: voiceCalls.toNumber,
      })
      .from(voiceCalls)
      .where(where)
      .limit(1);
    return rows[0] ?? null;
  }

  async function dispatchVoiceWebhook(
    event: VoiceEvent,
    webhookProviderId?: string,
  ): Promise<VoiceIngestDescriptor[]> {
    if (!db) return [];
    const mapping = WEBHOOK_TO_VOICE_STATUS[event.type];
    if (!mapping) return [];

    const row = await resolveRow(event, webhookProviderId);
    if (!row) return []; // unknown call — nothing to advance or wake

    // Guarded-monotonic status + outcome persist. May match 0 rows on a late/
    // duplicate callback — that's FINE: the ingest below runs regardless.
    await advanceStatus(event, mapping, row.voiceCallId);

    if (event.type === "voice.failed" && event.failure?.class === "permanent") {
      await suppressPermanent(event.phone);
    }

    // Only terminal events wake journeys / fan out; call_started does not.
    if (!TERMINAL_EVENTS.has(event.type)) return [];

    const to = normalizePhone(row.toNumber) ?? row.toNumber;
    const ended = event.ended;

    // External webhook fan-out (best-effort; deduped per row).
    void emitTerminal(event, row, to).catch((err: unknown) => {
      logger.warn("emitOutbound voice terminal failed", {
        voiceCallId: row.voiceCallId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    if (!row.userId) return []; // can't scope a journey-bus event without a user

    const baseProps: Record<string, unknown> = {
      voiceCallId: row.voiceCallId,
      agentKey: row.agentKey,
      phone: to,
      reason: ended?.reason ?? null,
      durationSec: ended?.durationSec ?? null,
    };

    const descriptors: VoiceIngestDescriptor[] = [
      {
        userId: row.userId,
        event: event.type,
        properties: baseProps,
        idempotencyKey: `voice:${event.type}:${row.voiceCallId}`,
      },
    ];

    // Data collection: the extracted fields ride their OWN event (namespaced
    // under `data` so operator keys can never clobber `voiceCallId`/`agentKey`)
    // AND are written to the contact's properties.
    if (event.type === "voice.call_ended" && ended?.structuredData) {
      descriptors.push({
        userId: row.userId,
        event: "voice.data_collected",
        properties: {
          voiceCallId: row.voiceCallId,
          agentKey: row.agentKey,
          data: ended.structuredData,
        },
        contactProperties: ended.structuredData,
        idempotencyKey: `voice:data_collected:${row.voiceCallId}`,
      });
    }
    return descriptors;
  }

  async function advanceStatus(
    event: VoiceEvent,
    mapping: { status: VoiceCallStatus; allowedFrom: VoiceCallStatus[] },
    voiceCallId: string,
  ): Promise<void> {
    if (!db) return;
    const ended = event.ended;
    const now = new Date();
    await db
      .update(voiceCalls)
      .set({
        status: mapping.status,
        updatedAt: now,
        ...(mapping.status !== "ringing" ? { endedAt: now } : {}),
        ...(ended?.reason ? { endedReason: ended.reason } : {}),
        ...(ended?.durationSec !== undefined
          ? { durationSec: ended.durationSec }
          : {}),
        ...(ended?.recordingUrl ? { recordingUrl: ended.recordingUrl } : {}),
        ...(ended?.transcript ? { transcript: ended.transcript } : {}),
        ...(ended?.summary ? { summary: ended.summary } : {}),
        ...(ended?.structuredData
          ? { structuredData: ended.structuredData }
          : {}),
        ...(ended?.cost !== undefined ? { cost: ended.cost } : {}),
        ...(event.failure?.code ? { errorCode: event.failure.code } : {}),
        ...(event.failure?.reason ? { errorReason: event.failure.reason } : {}),
      })
      .where(
        and(
          eq(voiceCalls.id, voiceCallId),
          inArray(voiceCalls.status, mapping.allowedFrom),
        ),
      );
  }

  async function emitTerminal(
    event: VoiceEvent,
    row: CallRowCtx,
    to: string,
  ): Promise<void> {
    if (!db) return;
    const ended = event.ended;
    const base = {
      voiceCallId: row.voiceCallId,
      agentKey: row.agentKey,
      userId: row.userId,
      to,
      at: new Date().toISOString(),
      reason: ended?.reason ?? null,
      durationSec: ended?.durationSec ?? null,
    };
    if (
      event.type === "voice.call_ended" ||
      event.type === "voice.no_answer" ||
      event.type === "voice.voicemail"
    ) {
      await emitOutbound({
        db,
        hatchet,
        logger,
        event: event.type,
        dedupeKey: `${event.type}:${row.voiceCallId}`,
        payload: base,
      });
    } else if (event.type === "voice.failed") {
      await emitOutbound({
        db,
        hatchet,
        logger,
        event: "voice.failed",
        dedupeKey: `voice.failed:${row.voiceCallId}`,
        payload: {
          ...base,
          ...(event.failure?.code ? { errorCode: event.failure.code } : {}),
          ...(event.failure?.reason
            ? { errorReason: event.failure.reason }
            : {}),
        },
      });
    }
  }

  async function suppressPermanent(phone: string): Promise<void> {
    if (!db) return;
    const normalized = normalizePhone(phone) ?? phone;
    if (!normalized) return;
    const now = new Date();
    await db
      .insert(voiceSuppressions)
      .values({
        phone: normalized,
        reason: "carrier",
        source: "provider",
        suppressedAt: now,
      })
      .onConflictDoUpdate({
        target: voiceSuppressions.phone,
        set: { reason: "carrier", suppressedAt: now, updatedAt: now },
      });
  }

  return service;
}
