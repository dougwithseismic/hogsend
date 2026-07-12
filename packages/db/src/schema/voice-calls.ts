import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { voiceCallStatusEnum } from "./enums.js";
import { journeyStates } from "./journey-states.js";

/**
 * One row per AI voice call (outbound OR inbound). The voice sibling of
 * `sms_sends` / `email_sends`: the engine's tracked caller inserts a `queued`
 * row before `provider.startCall`, the provider's status/end-of-call webhooks
 * advance it, and the terminal report lands the transcript + recording + the
 * extracted structured data. Unlike SMS there is no wire body / segment count;
 * instead the call carries a conversation outcome.
 */
export const voiceCalls = pgTable(
  "voice_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    journeyStateId: uuid("journey_state_id").references(() => journeyStates.id),
    // Denormalized recipient identity, set at call time (mirrors sms_sends).
    userId: text("user_id"),
    // The registered voice-agent key that drove the call.
    agentKey: text("agent_key"),
    // The active provider's id (e.g. "vapi") — which registry entry owns the
    // provider call id below.
    providerId: text("provider_id"),
    // The provider's call id (Vapi call id), set once startCall returns.
    providerCallId: text("provider_call_id"),
    // "outbound" | "inbound".
    direction: text("direction").notNull().default("outbound"),
    fromNumber: text("from_number"),
    toNumber: text("to_number").notNull(),
    status: voiceCallStatusEnum("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Call length in seconds, from the provider's end-of-call report.
    durationSec: integer("duration_sec"),
    // The provider's normalized endedReason (why the call terminated).
    endedReason: text("ended_reason"),
    recordingUrl: text("recording_url"),
    // The full transcript (array of { role, text, at }) from end-of-call.
    transcript: jsonb("transcript").$type<unknown>(),
    summary: text("summary"),
    // The provider-extracted structured data (per the agent's dataSchema) —
    // the data-collection payload. Also surfaced as `voice.data_collected`.
    structuredData: jsonb("structured_data").$type<Record<string, unknown>>(),
    // Best-effort provider-reported call cost (voice is $/min — worth storing
    // for a spend guard). doublePrecision, not the integer segments of SMS.
    cost: doublePrecision("cost"),
    errorCode: text("error_code"),
    errorReason: text("error_reason"),
    // Deterministic idempotency key — same contract as sms_sends. Journey calls
    // auto-derive `journeyVoiceCall:<runAnchor>:<site>:<agent>` (a disjoint
    // prefix from email's `journeySend:` and SMS's `journeySmsSend:` so a call
    // and a message under one wait label never collide). Nullable; NULLs are
    // distinct in Postgres so unkeyed/raw calls never collide.
    idempotencyKey: text("idempotency_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    index("voice_calls_to_number_idx").on(table.toNumber),
    index("voice_calls_agent_key_idx").on(table.agentKey),
    index("voice_calls_status_idx").on(table.status),
    index("voice_calls_created_at_idx").on(table.createdAt),
    index("voice_calls_journey_state_id_idx").on(table.journeyStateId),
    index("voice_calls_user_id_idx").on(table.userId),
    // Serves the provider-webhook by-call resolver.
    index("voice_calls_provider_call_id_idx").on(table.providerCallId),
    // Serves the frequency-cap COUNT (recipient + recency).
    index("voice_calls_freq_cap_idx").on(table.toNumber, table.createdAt),
    uniqueIndex("voice_calls_idempotency_key_idx").on(table.idempotencyKey),
  ],
);
