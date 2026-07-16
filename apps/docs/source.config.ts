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

export const blog = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: frontmatterSchema.extend({
    /** Publication date (YYYY-MM-DD; YAML may parse it as a Date). */
    date: z
      .union([z.string(), z.date()])
      .transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v))
      .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    /** Author id — must exist in lib/blog/authors.ts. */
    author: z.string(),
    /** Tag slugs — must exist in lib/blog/tags.ts. */
    tags: z.array(z.string()).min(1),
    /** Pin this post as the big featured card on /blog. */
    featured: z.boolean().default(false),
    /** Optional cover image path under /public. */
    image: z.string().optional(),
  }),
});

export default defineConfig({
  mdxOptions: {},
});
