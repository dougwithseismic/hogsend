import { defineVoiceAgent } from "@hogsend/voice";

export interface AppointmentSetterProps {
  /** The business the agent is calling on behalf of. */
  businessName: string;
  /** The contact's first name, used to open warmly. */
  firstName?: string;
}

/**
 * An outbound appointment-setting agent. Opens with an explicit AI disclosure
 * (required for AI/prerecorded calls in several US states), qualifies interest,
 * checks availability, and books a slot via the `bookAppointment` tool — then
 * extracts a small structured-data payload the journey can branch on.
 *
 * Prompt fields use `{{variable}}` placeholders resolved from the call's
 * `variables` bag (Vapi also fills these server-side).
 */
export const appointmentSetter = defineVoiceAgent({
  category: "journey",
  description: "Outbound appointment setter with AI disclosure + booking tool.",
  build: (p: AppointmentSetterProps) => ({
    // Prompt fields are built from PROPS (interpolated at build time) — no
    // `{{variable}}` placeholders, which would need a matching `variables` bag on
    // `startCall` or Vapi's dynamic-variable fill would leave them literal.
    systemPrompt: [
      `You are a friendly scheduling assistant calling on behalf of ${p.businessName}.`,
      `You MUST disclose in your first sentence that you are an automated AI assistant.`,
      `Goal: gauge interest in a quick demo, and if interested, use the`,
      `bookAppointment tool to reserve a slot. Keep it under two minutes. If the`,
      `person asks to stop being called, acknowledge, call the optOut tool, and`,
      `end the call politely. Never be pushy.`,
    ].join(" "),
    firstMessage: `Hi ${p.firstName ?? "there"}, this is an automated AI assistant calling on behalf of ${p.businessName}. Do you have a quick moment?`,
    // Vapi's native "Elliot" voice — ~370ms latency, $0.02/min, high naturalness,
    // no extra ElevenLabs key needed. Swap to `{ provider: "11labs", voiceId }`
    // for an ElevenLabs voice.
    voice: { provider: "vapi", voiceId: "Elliot" },
    // Latest fast, NON-reasoning Claude that Vapi accepts (its allow-list lags
    // Anthropic's newest). Voice needs low TTFT — a reasoning model pauses
    // audibly. Swap to `claude-haiku-4-5-20251001` for the lowest latency.
    model: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      temperature: 0.5,
    },
    tools: [
      {
        name: "bookAppointment",
        description: "Reserve a demo slot on the calendar.",
        parameters: {
          type: "object",
          properties: {
            slotIso: {
              type: "string",
              description: "ISO 8601 start time the caller agreed to.",
            },
          },
          required: ["slotIso"],
        },
      },
      {
        name: "optOut",
        description: "Record that the caller asked to stop being called.",
        parameters: { type: "object", properties: {} },
      },
    ],
    dataSchema: {
      type: "object",
      properties: {
        interested: { type: "boolean" },
        booked: { type: "boolean" },
        objection: { type: "string" },
      },
    },
    endCallPhrases: ["goodbye", "have a great day"],
    maxDurationSec: 300,
  }),
});
