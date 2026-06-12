// Copies brand assets into public/ so Remotion can serve them via
// staticFile(). Idempotent — run any time with `pnpm assets`.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const videoRoot = resolve(here, "..");
const repoRoot = resolve(videoRoot, "../..");

const out = {
  screenshots: join(videoRoot, "public/screenshots"),
  logos: join(videoRoot, "public/logos"),
  fonts: join(videoRoot, "public/fonts"),
};
for (const dir of Object.values(out)) {
  mkdirSync(dir, { recursive: true });
}

// 1. Studio screenshots used by BrowserChrome scenes
const screenshotSrc = join(repoRoot, "marketing/screenshots/studio");
const screenshots = [
  "01-overview.png",
  "02-sends.png",
  "04-journeys.png",
  "11-send-drawer.png",
  "10-debug.png",
];
for (const file of screenshots) {
  copyFileSync(join(screenshotSrc, file), join(out.screenshots, file));
}

// 2. Integration logos (single-colour SVG masks — tint white via CSS mask)
const logoSrc = join(repoRoot, "apps/docs/public/images/logos");
const logos = readdirSync(logoSrc).filter((f) => f.endsWith(".svg"));
for (const file of logos) {
  copyFileSync(join(logoSrc, file), join(out.logos, file));
}

// 3. Fonts: Inter Display (vendored in apps/docs) + Geist Mono (geist pkg)
const interSrc = join(repoRoot, "apps/docs/lib/fonts");
for (const file of [
  "InterDisplay-Regular.woff2",
  "InterDisplay-Medium.woff2",
]) {
  copyFileSync(join(interSrc, file), join(out.fonts, file));
}
const geistSrc = join(videoRoot, "node_modules/geist/dist/fonts/geist-mono");
for (const file of ["GeistMono-Regular.woff2", "GeistMono-Medium.woff2"]) {
  copyFileSync(join(geistSrc, file), join(out.fonts, file));
}

console.log(
  `assets ready: ${screenshots.length} screenshots, ${logos.length} logos, 4 fonts`,
);
