# @hogsend/voice

Voice-agent **authoring machinery** for Hogsend — the voice sibling of
`@hogsend/email` / `@hogsend/sms`. It ships **no concrete agents**: consumers
author their own agent definitions + tools and augment the open
`VoiceAgentRegistryMap`.

The provider-neutral wire contract (`VoiceProvider`, `VoiceEvent`,
`VoiceToolCall`, `defineVoiceProvider`, …) lives in `@hogsend/core`. This package
is the **content** layer:

- `defineVoiceAgent({ build, category?, ... })` — map typed props to a
  provider-neutral `VoiceAgentConfig` (system prompt, first message, voice,
  tools, `dataSchema`). Prompt fields may carry `{{variable}}` placeholders.
- `defineVoiceTool({ spec, handler })` — an executable tool: the wire `spec`
  (name + JSON-schema params, sent to the provider) plus the `handler` the engine
  runs when the agent calls it mid-call (book / sell / look up / save data).
- `renderVoiceAgent({ key, props, registry, variables })` — resolve an agent to a
  provider-ready config and interpolate its variables.
- `withSources`, `createVoiceRegistry`, `createVoiceToolRegistry`,
  `getVoiceAgentNames`, `getVoiceAgentDefinition` — registry helpers.

## Authoring an agent

```ts
// src/voice/appointment-setter.ts
import { defineVoiceAgent } from "@hogsend/voice";

export const appointmentSetter = defineVoiceAgent({
  category: "journey",
  build: (p: { businessName: string }) => ({
    systemPrompt: `You are the scheduling assistant for {{businessName}}. \
Disclose that you are an automated assistant. Book a slot, then confirm.`,
    firstMessage: `Hi, this is the automated assistant for ${p.businessName}.`,
    tools: [{ name: "bookAppointment", parameters: { type: "object" } }],
    dataSchema: { type: "object", properties: { interested: { type: "boolean" } } },
  }),
});
```

```ts
// src/voice/templates.d.ts
declare module "@hogsend/voice" {
  interface VoiceAgentRegistryMap {
    "appointment-setter": { businessName: string };
  }
}
```

Register the agents + tools and pass `voice: { agents, tools }` to
`createHogsendClient` in **both** `index.ts` and `worker.ts`.

See `docs/voice-agent-plan.md` for the full channel architecture.
