import type { JSX } from "react";
import { TrackDemoClick } from "@/components/analytics/track";
import { DEMO_URL } from "@/lib/site";

/**
 * StudioDemoCallout — the "click around a real Studio" card for MDX pages
 * (registered in getMDXComponents). Every link to demo.hogsend.com goes
 * through TrackDemoClick, so the click is captured in PostHog and lands in
 * the dogfood ingest on the visitor's contact.
 */
export function StudioDemoCallout({
  placement = "docs",
}: {
  placement?: string;
}): JSX.Element {
  return (
    <div className="not-prose my-6 rounded-lg border border-[#f64838]/25 bg-[#f64838]/[0.06] p-5">
      <p className="font-mono text-[#f64838] text-[11px] uppercase tracking-[0.08em]">
        Live demo
      </p>
      <p className="mt-2.5 text-sm text-white/75 leading-6">
        You can click around a real Studio before you install anything.
        demo.hogsend.com is a stock Hogsend install seeded as Forgeline — a
        fictional AI code-review product with six months of contacts, sends,
        journeys, and campaigns. The shared sign-in is on its landing page; no
        email provider is configured, so nothing in it can send real mail.
      </p>
      <TrackDemoClick placement={placement}>
        <a
          href={DEMO_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center rounded-[6px] bg-white px-4 py-2 font-medium text-[#0a0a0a] text-sm transition-colors hover:bg-white/90"
        >
          Open the live demo →
        </a>
      </TrackDemoClick>
    </div>
  );
}
