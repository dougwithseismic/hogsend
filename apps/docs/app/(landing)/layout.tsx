import { Montserrat } from "next/font/google";
import type { ReactNode } from "react";
import { VisitorTeamProvider } from "./_components/team-context";
import "./home.css";

/**
 * Homepage layout — the spike-polar layout re-set in the dark crimzon scheme
 * (#050101 ink ground, #F64838 accent; the layout/typography came from the
 * /spike-polar Polar Signals exploration, now promoted).
 *
 * Standalone by design: deliberately opts out of the shared SiteNav /
 * SiteFooter / PageFrame chrome the rest of the marketing pages use — the
 * homepage carries its own nav, footer, and frame.
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
    <div
      className={`${display.variable} min-h-screen bg-[var(--tw-ink)] text-white/75`}
    >
      <VisitorTeamProvider>{children}</VisitorTeamProvider>
    </div>
  );
}
