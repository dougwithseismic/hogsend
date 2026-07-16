/**
 * Playbook channel registry (the "what does it run on" filter axis). Every
 * `channels` entry in a play's frontmatter must be a key here — unknown slugs
 * fail the build via getAllPlays in lib/playbook/index.ts.
 */
export const CHANNELS = {
  email: { label: "Email" },
  sms: { label: "SMS" },
  ads: { label: "Paid ads" },
  video: { label: "Video" },
  discord: { label: "Discord" },
  "in-app": { label: "In-app" },
  "direct-mail": { label: "Direct mail" },
} as const;

export type ChannelSlug = keyof typeof CHANNELS;

export function isChannelSlug(slug: string): slug is ChannelSlug {
  return slug in CHANNELS;
}
