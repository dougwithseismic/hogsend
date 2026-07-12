import {
  createVoiceToolRegistry,
  type VoiceAgentRegistry,
  type VoiceToolRegistry,
  withSources,
} from "@hogsend/voice";
import { appointmentSetter } from "./appointment-setter.js";
import { bookAppointment, optOut } from "./tools.js";

// This app's voice-agent registry — CONTENT. Maps each key to its definition.
// Passed to `createHogsendClient({ voice: { agents } })`, threaded to the
// engine's tracked voice caller at call-synthesis time. Keys MUST match the
// augmentation in `./templates.d.ts` for `startCall({ agent })` to type-check.
export const voiceAgents: VoiceAgentRegistry = withSources(
  import.meta.dirname,
  {
    "appointment-setter": appointmentSetter,
  },
);

// This app's mid-call tool registry, name-keyed. Passed as
// `createHogsendClient({ voice: { tools } })`; the engine's dispatcher resolves
// a Vapi `tool-calls` webhook against it and replies synchronously.
export const voiceTools: VoiceToolRegistry = createVoiceToolRegistry([
  bookAppointment,
  optOut,
]);
