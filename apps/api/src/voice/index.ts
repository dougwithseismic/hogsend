// This app's voice content. `voiceAgents` + `voiceTools` are passed to
// `createHogsendClient({ voice: { agents, tools } })`; `./templates.d.ts`
// augments `@hogsend/voice`'s `VoiceAgentRegistryMap` so calls are type-checked.

export type { AppointmentSetterProps } from "./appointment-setter.js";
export { voiceAgents, voiceTools } from "./registry.js";
