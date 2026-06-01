// Module augmentation (Option B) — this is what makes
// `emailService.send({ template, props })` fully type-checked against YOUR
// templates. `@hogsend/email` ships an empty `TemplateRegistryMap`; here we
// declare each template key and the props its component expects. Keep these
// keys in sync with `./registry.ts` and the `Templates` constants in
// `src/journeys/constants/index.ts`.

import type { ActivationNudgeEmailProps, WelcomeEmailProps } from "./types.js";

declare module "@hogsend/email" {
  interface TemplateRegistryMap {
    "activation/welcome": WelcomeEmailProps;
    "activation/nudge": ActivationNudgeEmailProps;
  }
}
