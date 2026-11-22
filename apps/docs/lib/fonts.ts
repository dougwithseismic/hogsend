import { Geist_Mono, Inter } from "next/font/google";
import localFont from "next/font/local";

/**
 * Display face: Inter Display (the dedicated optical-size family from the
 * rsms Inter release — next/font/google does not export it, so the woff2
 * files are vendored in lib/fonts/). 400 for section H2s, 500 for the hero.
 *
 * The site loads Latin subsets (`*-latin.woff2`, ~27 KB each against ~110 KB
 * for the full files): Google's `latin` unicode-range plus the arrows, ticks
 * and shapes the copy uses, with kerning, ligatures and tabular figures kept.
 * Anything outside the subset falls back to the adjusted system face. The
 * full files stay beside them for the Remotion pipeline
 * (marketing/video/scripts/prepare-assets.mjs). Regenerate with:
 *   pyftsubset InterDisplay-Regular.woff2 --flavor=woff2 \
 *     --output-file=InterDisplay-Regular-latin.woff2 \
 *     --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2212,U+2215,U+2248,U+2260,U+2264-2265,U+2318,U+25A0-25CF,U+2713-2717,U+FEFF,U+FFFD" \
 *     --layout-features="kern,liga,calt,ccmp,locl,mark,mkmk,tnum,case,frac,numr,dnom,sups,subs,zero"
 */
export const interDisplay = localFont({
  src: [
    {
      path: "./fonts/InterDisplay-Regular-latin.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/InterDisplay-Medium-latin.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  variable: "--ff-display",
  display: "swap",
});

/** Body face: Inter — everything that isn't a display heading or code. */
export const inter = Inter({
  subsets: ["latin"],
  variable: "--ff-body",
  display: "swap",
});

/** Mono — used ONLY inside code blocks/terminal mockups. */
export const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--ff-mono",
  display: "swap",
});
