import {
  defineConfig,
  defineDocs,
  frontmatterSchema,
} from "fumadocs-mdx/config";
import { z } from "zod";

export const courses = defineDocs({
  dir: "content/courses",
  docs: {
    schema: frontmatterSchema.extend({
      /**
       * The chapter's workbook intro — one short paragraph, framed on what the
       * reader PRODUCES here, that makes the chapter's workbook section
       * completable standalone on /workbook. Falls back to `description`.
       */
      workbook: z.string().optional(),
    }),
  },
});

export default defineConfig({
  mdxOptions: {},
});
