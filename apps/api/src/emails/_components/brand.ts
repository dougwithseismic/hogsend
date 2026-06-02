// Brand constants for Hogsend's own lifecycle emails. These are the dogfood
// examples that ship with the engine — every template below is a real email
// Hogsend would send to a developer adopting it. Edit these in your own app to
// point at your product; the templates read them as prop defaults.

export const BRAND = {
  name: "Hogsend",
  tagline: "Lifecycle email as code, for teams on PostHog + Resend.",
  siteUrl: "https://hogsend.com",
  appUrl: "https://app.hogsend.com",
  docsUrl: "https://hogsend.com/docs",
  quickstartUrl: "https://hogsend.com/docs/quickstart",
  communityUrl: "https://hogsend.com/community",
  communityName: "the Hogsend Discord",
  supportEmail: "support@hogsend.com",
} as const;
