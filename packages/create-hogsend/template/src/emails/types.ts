// Prop types for your email templates. These are CONTENT — they live in your
// repo alongside the `.tsx` files and the registry, and you edit them freely.
// The open `TemplateRegistryMap` in `@hogsend/email` is augmented with these in
// `./templates.d.ts`, which is what makes
// `emailService.send({ template, props })` type-check.

export interface WelcomeEmailProps {
  name: string;
  dashboardUrl?: string;
  unsubscribeUrl?: string;
}

export interface ActivationNudgeEmailProps {
  name: string;
  featureName?: string;
  nudgeMessage?: string;
  ctaUrl?: string;
  ctaText?: string;
  helpUrl?: string;
  unsubscribeUrl?: string;
}
