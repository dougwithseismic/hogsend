import type { TemplateRegistry } from "@hogsend/email";
import ActivationNudgeEmail from "./activation-nudge.js";
import WelcomeEmail from "./welcome.js";

// Your app's template registry — CONTENT. Maps each template key to its
// component + default subject + category (+ optional preview text). Passed to
// `createHogsendClient({ email: { templates } })`, which threads it through the engine's
// `TrackedMailer` to `getTemplate(..., { registry })` at send + render time.
//
// The keys here MUST match the keys augmented into `@hogsend/email`'s
// `TemplateRegistryMap` (see `./templates.d.ts`) for `send({ template, props })`
// to type-check. They also match the `Templates` constants journeys send with
// (see `src/journeys/constants/index.ts`).
//
// These two are starters — add, delete, or rename freely.
export const templates: TemplateRegistry = {
  "activation/welcome": {
    component: WelcomeEmail,
    defaultSubject: "Welcome to {{APP_NAME}}",
    category: "transactional",
    preview: (props) => `Welcome to {{APP_NAME}}, ${props.name}!`,
  },
  "activation/nudge": {
    component: ActivationNudgeEmail,
    defaultSubject: "You haven't tried the key feature yet",
    category: "journey",
    preview: (props) => `${props.name}, you're missing out`,
  },
};
