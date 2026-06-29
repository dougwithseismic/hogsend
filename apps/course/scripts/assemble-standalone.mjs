// Next's standalone output (output: "standalone") emits a self-contained
// server.js + minimal node_modules, but it intentionally does NOT copy the
// static assets (.next/static) or the public/ dir into the standalone tree —
// the Next docs leave that to the deploy step. Without this, the server runs
// but every CSS/JS chunk and public asset 404s.
//
// With outputFileTracingRoot set to the monorepo root, the standalone tree
// mirrors the repo layout, so this app's server lives at
//   .next/standalone/apps/course/server.js
// and expects its assets at
//   .next/standalone/apps/course/.next/static  and  .next/standalone/apps/course/public
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standaloneApp = resolve(appDir, ".next/standalone/apps/course");

const copies = [
  {
    from: resolve(appDir, ".next/static"),
    to: resolve(standaloneApp, ".next/static"),
  },
  { from: resolve(appDir, "public"), to: resolve(standaloneApp, "public") },
];

for (const { from, to } of copies) {
  if (!existsSync(from)) continue;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`assembled standalone: ${from} -> ${to}`);
}
