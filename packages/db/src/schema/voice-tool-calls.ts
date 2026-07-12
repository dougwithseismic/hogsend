import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { voiceCalls } from "./voice-calls.js";

/**
 * One row per mid-call tool invocation — the idempotency + audit ledger for
 * `dispatchVoiceToolCalls`. Provider webhooks are retried, and a retried
 * `tool-calls` webhook must NOT re-run a side-effecting tool (a double-booking).
 * The unique `tool_call_id` makes the dispatcher insert-or-return: a repeat of
 * the same `toolCallId` reads the STORED result instead of re-executing.
 */
export const voiceToolCalls = pgTable(
  "voice_tool_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    voiceCallId: uuid("voice_call_id").references(() => voiceCalls.id),
    // The provider-issued tool-call id (Vapi toolCallList[].id) — globally unique
    // per invocation, so it is the natural idempotency key.
    toolCallId: text("tool_call_id").notNull(),
    name: text("name").notNull(),
    // The serialized result string returned to the provider — replayed verbatim
    // on a retry so the agent reads back the same answer.
    result: text("result"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("voice_tool_calls_tool_call_id_idx").on(table.toolCallId),
    index("voice_tool_calls_voice_call_id_idx").on(table.voiceCallId),
  ],
);
