import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const courses = defineDocs({
  dir: "content/courses",
});

export default defineConfig({
  mdxOptions: {},
});
