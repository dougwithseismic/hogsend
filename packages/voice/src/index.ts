// @hogsend/voice — voice-agent authoring machinery only. No concrete agents are
// baked in here; clients own their `.ts` agent definitions + registry and augment
// the open `VoiceAgentRegistryMap` interface (module augmentation). The provider
// contract (`VoiceProvider`, `VoiceEvent`, …) lives in `@hogsend/core`.

// Authoring factories
export { defineVoiceAgent, defineVoiceTool } from "./define.js";
// Agent registry
export {
  createVoiceRegistry,
  createVoiceToolRegistry,
  getVoiceAgentDefinition,
  getVoiceAgentNames,
  withSources,
} from "./registry.js";
// Rendering (agent config synthesis + variable interpolation)
export { interpolate, renderVoiceAgent } from "./render.js";
// Types
export type {
  VoiceAgentDefinition,
  VoiceAgentName,
  VoiceAgentRegistry,
  VoiceAgentRegistryMap,
  VoiceAgentRenderResult,
  VoiceTool,
  VoiceToolContext,
  VoiceToolHandlerResult,
  VoiceToolRegistry,
} from "./types.js";
// Runtime values & error classes
export { VoiceCallError } from "./types.js";
