import { loadFont } from "@remotion/fonts";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { staticFile } from "remotion";

/**
 * Loads all three brand fonts. Importing this module (directly or via any
 * component that uses the family constants) blocks rendering until the
 * fonts are ready — @remotion/fonts and @remotion/google-fonts both call
 * delayRender() internally.
 *
 * - Inter Display: vendored woff2 (copied from apps/docs by `pnpm assets`)
 * - Inter: Google Fonts
 * - Geist Mono: vendored woff2 from the `geist` npm package
 */

export const FONT_DISPLAY = "Inter Display";
export const FONT_BODY = "Inter";
export const FONT_MONO = "Geist Mono";

const local = [
  { family: FONT_DISPLAY, file: "InterDisplay-Regular.woff2", weight: "400" },
  { family: FONT_DISPLAY, file: "InterDisplay-Medium.woff2", weight: "500" },
  { family: FONT_MONO, file: "GeistMono-Regular.woff2", weight: "400" },
  { family: FONT_MONO, file: "GeistMono-Medium.woff2", weight: "500" },
];

export const fontsReady: Promise<unknown> = Promise.all([
  ...local.map(({ family, file, weight }) =>
    loadFont({ family, url: staticFile(`fonts/${file}`), weight }),
  ),
  loadInter("normal", {
    weights: ["400", "500"],
    subsets: ["latin"],
  }).waitUntilDone(),
]);
