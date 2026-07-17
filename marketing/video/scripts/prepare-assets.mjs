// Copies brand assets into public/ so Remotion can serve them via
// staticFile(). Idempotent — run any time with `pnpm assets`.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const videoRoot = resolve(here, "..");
const repoRoot = resolve(videoRoot, "../..");

const out = {
  screenshots: join(videoRoot, "public/screenshots"),
  logos: join(videoRoot, "public/logos"),
  fonts: join(videoRoot, "public/fonts"),
  textures: join(videoRoot, "public/images/textures"),
  studio: join(videoRoot, "public/images/studio"),
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
const copiedScreenshots = screenshots.filter((file) => {
  const source = join(screenshotSrc, file);
  if (!existsSync(source)) return false;
  copyFileSync(source, join(out.screenshots, file));
  return true;
});

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

// 4. Thermal textures used by the shared Docs/Remotion brand frame.
const textureSrc = join(repoRoot, "apps/docs/public/images/textures");
for (const file of ["thermal-1.webp", "thermal-2.webp"]) {
  copyFileSync(join(textureSrc, file), join(out.textures, file));
}

// 5. Required real product screens for the Kinetic Overdrive campaign.
const productScreens = {
  overview: "02-overview-dashboard.png",
  journeys: "08-journeys-overview.png",
  contacts: "10-contacts-directory.png",
  campaigns: "07-campaigns-list.png",
  sends: "04-sends-history.png",
};
const studioSrc = join(repoRoot, "apps/docs/public/images/studio");
for (const [name, file] of Object.entries(productScreens)) {
  copyFileSync(join(studioSrc, file), join(out.studio, `${name}.png`));
}

console.log(
  `assets ready: ${copiedScreenshots.length}/${screenshots.length} optional screenshots, ${logos.length} logos, 4 fonts, 2 textures, 5 product screenshots`,
);
