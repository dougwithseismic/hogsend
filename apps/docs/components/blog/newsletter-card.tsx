import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { EmailCapture } from "@/components/landing/email-capture";

/**
 * Closing band on blog pages: the standard footer email capture inside a
 * card, with blog-specific framing.
 */
export function NewsletterCard(): JSX.Element {
  return (
    <div className="rounded-md border border-white/[0.08] bg-white/[0.015] p-6 md:p-10">
      <div className="grid gap-8 md:grid-cols-2 md:gap-12">
        <div>
          <Eyebrow className="mb-4">Newsletter</Eyebrow>
          <h2 className="font-display text-[26px] text-white leading-[1.2] tracking-[-0.02em] md:text-[32px]">
            Get new posts by email
          </h2>
          <p className="mt-4 max-w-md text-base text-white/60 leading-6">
            Growth, technical marketing, and GTM for teams that code — written
            from client work, not theory. No schedule promises; posts go out
            when there is something worth saying.
          </p>
        </div>
        <EmailCapture hideHeading placement="footer" />
      </div>
    </div>
  );
}
