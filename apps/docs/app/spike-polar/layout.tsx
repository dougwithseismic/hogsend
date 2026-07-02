import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import type { ReactNode } from "react";
import "./spike.css";

/**
 * SPIKE — Polar Signals design-system exploration (polarsignals.com).
 *
 * Standalone light-theme layout: deliberately opts out of the crimzon
 * SiteNav / SiteFooter / PageFrame so the page can carry its own nav and
 * footer in the borrowed design language. Not linked from anywhere and
 * noindexed — throwaway spike, branch-only.
 *
 * Display face: Polar Signals uses Articulat CF (Adobe Fonts, weight 400,
 * tight tracking). Montserrat 400 is the closest freely-licensed stand-in
 * (same Proxima-adjacent geometric grotesque family), loaded only on this
 * route.
 */
const display = Montserrat({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--ps-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Hogsend — Polar Signals spike",
  robots: { index: false, follow: false },
};

export default function SpikeLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${display.variable} min-h-screen bg-white text-[#2e3038]`}>
      {children}
    </div>
  );
}
