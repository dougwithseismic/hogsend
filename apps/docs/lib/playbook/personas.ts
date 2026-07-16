/**
 * Playbook persona registry (the "browse by role" axis from #492). Every
 * `personas` entry in a play's frontmatter must be a key here — unknown slugs
 * fail the build. `short` is the compact chip label on cards.
 */
export const PERSONAS = {
  gtm: { label: "GTM & marketing teams", short: "GTM" },
  founders: { label: "Founders & sales-adjacent", short: "Founders" },
  recruiters: { label: "Recruiters & talent", short: "Recruiters" },
  internal: { label: "Internal teams", short: "Internal" },
  agencies: { label: "Consultants & agencies", short: "Agencies" },
} as const;

export type PersonaSlug = keyof typeof PERSONAS;

export function isPersonaSlug(slug: string): slug is PersonaSlug {
  return slug in PERSONAS;
}
