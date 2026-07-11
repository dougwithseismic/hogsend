// Module augmentation — makes `sendSms({ template, props })` and
// `smsService.send(...)` type-checked against THIS app's SMS templates.
// `@hogsend/sms` ships an empty `SmsTemplateRegistryMap`; here we declare each
// key and the props its component expects. Keep in sync with `./registry.ts`.

import type { WelcomeSmsProps, WinbackSmsProps } from "./types.js";

declare module "@hogsend/sms" {
  interface SmsTemplateRegistryMap {
    "welcome-sms": WelcomeSmsProps;
    "winback-sms": WinbackSmsProps;
  }
}
