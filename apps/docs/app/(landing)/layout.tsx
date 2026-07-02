import { Montserrat } from "next/font/google";
import type { ReactNode } from "react";
import "./home.css";

/**
 * Homepage layout — the light crimzon design language (adapted from the
 * Polar Signals system explored in the /spike-polar spike, now promoted).
 *
 * Standalone by design: deliberately opts out of the dark SiteNav /
 * SiteFooter / PageFrame chrome the rest of the marketing pages use — the
 * homepage carries its own nav, footer, and frame in the light system.
 *
 * Display face: Montserrat 400 (a freely-licensed Proxima-adjacent geometric
 * grotesque), loaded only on this route as --ps-display.
 */
const display = Montserrat({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--ps-display",
  display: "swap",
});

export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${display.variable} min-h-screen bg-white text-[#2e3038]`}>
      {children}
    </div>
  );
}
