import { getVoiceService } from "@hogsend/engine";
import { defineVoiceTool } from "@hogsend/voice";

// This app's mid-call voice tools — the executable side of the wire specs the
// agents declare. Each runs on the engine's synchronous tool-dispatch path while
// the call is live (the provider blocks on the reply), so keep them FAST.

/**
 * Book a demo slot. Example implementation — a real app hits its calendar
 * (Cal.com / Google Calendar) for `ctx.contactId`. Returns a short string the
 * agent reads back to the caller.
 */
export const bookAppointment = defineVoiceTool({
  spec: {
    name: "bookAppointment",
    description: "Reserve a demo slot on the calendar.",
    parameters: {
      type: "object",
      properties: { slotIso: { type: "string" } },
      required: ["slotIso"],
    },
  },
  handler: async (args: { slotIso: string }, _ctx) => {
    // TODO: call your calendar for _ctx.contactId. This stub just confirms.
    return {
      booked: true,
      slot: args.slotIso,
      message: `Booked for ${args.slotIso}. You'll get a confirmation text.`,
    };
  },
});

/**
 * Record an opt-out request voiced mid-call — writes the internal voice DNC
 * (`voice_suppressions`) for `ctx.phone` so the number is never dialed again,
 * then acknowledges so the agent can close politely.
 */
export const optOut = defineVoiceTool({
  spec: {
    name: "optOut",
    description: "Record that the caller asked to stop being called.",
    parameters: { type: "object", properties: {} },
  },
  handler: async (_args, ctx) => {
    if (ctx.phone) {
      await getVoiceService().recordOptOut(ctx.phone, { source: "tool" });
    }
    return {
      acknowledged: true,
      message: "Understood — I've added you to our do-not-call list. Goodbye.",
    };
  },
});
