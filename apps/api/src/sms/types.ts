// Props for this app's SMS templates. Keep in sync with `./registry.ts` and the
// `./templates.d.ts` augmentation of `@hogsend/sms`'s `SmsTemplateRegistryMap`.

export interface WelcomeSmsProps {
  name?: string;
  quickstartUrl?: string;
}

export interface WinbackSmsProps {
  name?: string;
  discountPercent?: number;
  offerUrl?: string;
}
