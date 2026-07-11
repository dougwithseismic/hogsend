// This app's SMS content. The `smsTemplates` registry is passed to
// `createHogsendClient({ sms: { templates } })`; `./templates.d.ts` augments
// `@hogsend/sms`'s `SmsTemplateRegistryMap` so sends are type-checked.

export { smsTemplates } from "./registry.js";

export type { WelcomeSmsProps, WinbackSmsProps } from "./types.js";
