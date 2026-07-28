import { Geist_Mono, Inter } from "next/font/google";
import localFont from "next/font/local";

/**
 * Display face: Inter Display (the dedicated optical-size family from the rsms
 * Inter release — next/font/google does not export it, so the woff2 files are
 * vendored in lib/fonts/). 400 for headings, 500 for the page title.
 */
export const interDisplay = localFont({
  src: [
    {
      path: "./fonts/InterDisplay-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/InterDisplay-Medium.woff2",
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

/** Mono — identifiers, keys, region codes. */
export const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--ff-mono",
  display: "swap",
});
