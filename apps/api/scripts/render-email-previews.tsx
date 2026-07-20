// Render every registered email template (with its registry `examples`) to
// static HTML for the docs gallery. Run from apps/api:
//   pnpm exec tsx scripts/render-email-previews.tsx [outDir] [key ...]
// Keys default to ALL registry keys; slashes in keys become hyphens in
// filenames (the flat-file convention).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderToHtml } from "@hogsend/email";
import { createElement } from "react";
import { templates } from "../src/emails/registry.js";

const outDir = process.argv[2] ?? "email-previews";
const only = process.argv.slice(3);

await mkdir(outDir, { recursive: true });

const keys = Object.keys(templates).filter(
  (k) => only.length === 0 || only.includes(k),
);

for (const key of keys) {
  const def = templates[key as keyof typeof templates];
  const props = {
    unsubscribeUrl: "https://api.hogsend.com/v1/email/unsubscribe/demo",
    ...(def.examples ?? {}),
  };
  const html = await renderToHtml(createElement(def.component, props));
  const file = path.join(outDir, `${key.replaceAll("/", "-")}.html`);
  await writeFile(file, html);
  console.log(`rendered ${key} -> ${file}`);
}
