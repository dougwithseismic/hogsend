import {
  defineCollections,
  defineConfig,
  defineDocs,
  frontmatterSchema,
} from "fumadocs-mdx/config";
import { z } from "zod";

export const docs = defineDocs({
  dir: "content/docs",
});

export const articles = defineCollections({
  type: "doc",
  dir: "content/articles",
  schema: frontmatterSchema.extend({
    /** Publication date (YYYY-MM-DD; YAML may parse it as a Date). */
    date: z
      .union([z.string(), z.date()])
      .transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v))
      .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    /** Author id — must exist in lib/articles/authors.ts. */
    author: z.string(),
    /** Tag slugs — must exist in lib/articles/tags.ts. */
    tags: z.array(z.string()).min(1),
    /** Pin this post as the big featured card on /articles. */
    featured: z.boolean().default(false),
    /** Optional cover image path under /public. */
    image: z.string().optional(),
  }),
});

export const playbook = defineCollections({
  type: "doc",
  dir: "content/playbook",
  schema: frontmatterSchema.extend({
    /** One-line "when to run it" symptom shown on cards + detail header. */
    hook: z.string(),
    /** Category slug — must exist in lib/playbook/categories.ts. */
    category: z.string(),
    /** Persona slugs — must exist in lib/playbook/personas.ts. Empty = everyone. */
    personas: z.array(z.string()).default([]),
    /** Channel slugs — must exist in lib/playbook/channels.ts. */
    channels: z.array(z.string()).default([]),
    /** Freeform search keywords. */
    tags: z.array(z.string()).default([]),
    /** Publication date (YYYY-MM-DD; YAML may parse it as a Date). */
    date: z
      .union([z.string(), z.date()])
      .transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v))
      .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    /** Blueprint slug — set when the play installs via `hogsend blueprint add`. */
    blueprint: z.string().optional(),
    /** Honest expectation label, e.g. "same day", "one week". */
    timeToResults: z.string().optional(),
  }),
});

export default defineConfig({
  mdxOptions: {},
});
