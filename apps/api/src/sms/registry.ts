import { type SmsTemplateRegistry, withSources } from "@hogsend/sms";
import WelcomeSms from "./welcome-sms.js";
import WinbackSms from "./winback-sms.js";

// This app's SMS template registry — CONTENT. Maps each key to its component
// (+ optional category/preview). Passed to
// `createHogsendClient({ sms: { templates } })`, threaded to the engine's
// tracked SMS sender at send + render time. Keys MUST match the augmentation in
// `./templates.d.ts` for `sendSms({ template })` to type-check.
export const smsTemplates: SmsTemplateRegistry = withSources(
  import.meta.dirname,
  {
    "welcome-sms": {
      component: WelcomeSms,
      category: "journey",
      preview: (props) => `Welcome ${props.name ?? "there"} to Hogsend`,
      examples: { name: "Ada" },
    },
    "winback-sms": {
      component: WinbackSms,
      category: "journey",
      preview: (props) =>
        `${props.name ?? "there"}, ${props.discountPercent ?? 25}% off to come back`,
      examples: { name: "Ada", discountPercent: 25 },
    },
  },
);
