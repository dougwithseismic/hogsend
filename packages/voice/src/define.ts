import type { VoiceAgentDefinition, VoiceTool } from "./types.js";

/**
 * Identity factory for a {@link VoiceAgentDefinition}. Returns its argument
 * unchanged but pins the literal shape and infers the props type `P` from the
 * `build` signature, so authoring an agent in its own file gets full checking
 * without repeating the props type. Mirrors the `defineJourney`/`defineSmsProvider`
 * ergonomics.
 *
 * ```ts
 * export const appointmentSetter = defineVoiceAgent({
 *   category: "journey",
 *   build: (p: { businessName: string }) => ({
 *     systemPrompt: `You book appointments for {{businessName}}.`,
 *     firstMessage: `Hi, this is the assistant for ${p.businessName}.`,
 *   }),
 * });
 * ```
 */
export function defineVoiceAgent<P = Record<string, unknown>>(
  definition: VoiceAgentDefinition<P>,
): VoiceAgentDefinition<P> {
  return definition;
}

/**
 * Identity factory for a {@link VoiceTool}. Infers the argument type `A` from the
 * handler so the wire `spec.parameters` (JSON Schema) and the typed handler args
 * are authored together in one place.
 *
 * ```ts
 * export const bookAppointment = defineVoiceTool({
 *   spec: {
 *     name: "bookAppointment",
 *     description: "Book a slot on the calendar.",
 *     parameters: {
 *       type: "object",
 *       properties: { slotIso: { type: "string" } },
 *       required: ["slotIso"],
 *     },
 *   },
 *   handler: async (args: { slotIso: string }, ctx) => {
 *     // ...hit the calendar for ctx.contactId...
 *     return { booked: true, slot: args.slotIso };
 *   },
 * });
 * ```
 */
export function defineVoiceTool<A = Record<string, unknown>>(
  tool: VoiceTool<A>,
): VoiceTool<A> {
  return tool;
}
