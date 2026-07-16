import { playbook } from "collections/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";
import { type CategorySlug, isCategorySlug } from "./categories";
import { isPersonaSlug, type PersonaSlug } from "./personas";

export const playbookSource = loader({
  baseUrl: "/playbook",
  source: toFumadocsSource(playbook, []),
});

export type Play = ReturnType<typeof playbookSource.getPages>[number];

/** All plays, newest first. Validates category + personas so typos fail the build. */
export function getAllPlays(): Play[] {
  const plays = playbookSource.getPages();
  for (const play of plays) {
    if (!isCategorySlug(play.data.category)) {
      throw new Error(
        `Unknown playbook category "${play.data.category}" in ${play.url}`,
      );
    }
    for (const persona of play.data.personas) {
      if (!isPersonaSlug(persona)) {
        throw new Error(`Unknown persona "${persona}" in ${play.url}`);
      }
    }
  }
  return plays.sort((a, b) => b.data.date.localeCompare(a.data.date));
}

/** Up to `limit` other plays in the same category, then pads with recents. */
export function getRelatedPlays(
  plays: Play[],
  current: Play,
  limit = 3,
): Play[] {
  const others = plays.filter((p) => p.url !== current.url);
  const same = others.filter((p) => p.data.category === current.data.category);
  const rest = others.filter((p) => !same.includes(p));
  return [...same, ...rest].slice(0, limit);
}

/** The light, serializable index the client-side explorer filters over. */
export type PlayIndexEntry = {
  url: string;
  title: string;
  hook: string;
  category: CategorySlug;
  personas: PersonaSlug[];
  tags: string[];
  installs: boolean;
  timeToResults?: string;
};

export function toPlayIndex(plays: Play[]): PlayIndexEntry[] {
  return plays.map((p) => ({
    url: p.url,
    title: p.data.title,
    hook: p.data.hook,
    category: p.data.category as CategorySlug,
    personas: p.data.personas as PersonaSlug[],
    tags: p.data.tags,
    installs: Boolean(p.data.blueprint),
    timeToResults: p.data.timeToResults,
  }));
}
