// Module augmentation — makes `startCall({ agent, props })` and
// `voiceService.startCall(...)` type-checked against THIS app's voice agents.
// `@hogsend/voice` ships an empty `VoiceAgentRegistryMap`; here we declare each
// key and the props its `build` expects. Keep in sync with `./registry.ts`.

import type { AppointmentSetterProps } from "./appointment-setter.js";

declare module "@hogsend/voice" {
  interface VoiceAgentRegistryMap {
    "appointment-setter": AppointmentSetterProps;
  }
}
