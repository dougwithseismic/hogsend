// Your app's email content. The `templates` registry is passed to
// `createHogsendClient({ email: { templates } })`; `./templates.d.ts` augments
// `@hogsend/email`'s `TemplateRegistryMap` so sends are type-checked.

export { templates } from "./registry.js";

export type { ActivationNudgeEmailProps, WelcomeEmailProps } from "./types.js";
