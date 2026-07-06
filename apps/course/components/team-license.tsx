import { Users } from "lucide-react";
import type { JSX } from "react";
import type { CourseMeta } from "@/lib/courses";
import { MAX_TEAM_SEATS, MIN_TEAM_SEATS } from "@/lib/license-seats";

/**
 * Team-licence affordance for a purchasable course: a zero-JS disclosure with
 * a plain form into /api/checkout's team mode. The buyer pays seats × price
 * in one session (one invoice); the webhook mints one single-use unlock code
 * per seat and emails the batch to the buyer to distribute. Signed-out buyers
 * bounce through sign-in, same as every checkout.
 */
export function TeamLicense({ course }: { course: CourseMeta }): JSX.Element {
  return (
    <details
      id="team"
      className="group mt-6 max-w-xl scroll-mt-28 rounded-md border border-white/[0.08] bg-white/[0.015]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 p-4 text-sm text-white/70 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
        <Users className="size-4 text-accent" strokeWidth={1.5} aria-hidden />
        <span className="font-medium">
          Buy for your team
          {course.priceLabel ? ` — ${course.priceLabel} per seat` : ""}
        </span>
        <span
          aria-hidden
          className="ml-auto text-white/40 transition-transform group-open:rotate-90"
        >
          →
        </span>
      </summary>
      <div className="border-white/[0.08] border-t p-4">
        <p className="text-sm text-white/55 leading-relaxed">
          One checkout, one invoice. We mint a single-use unlock code per seat
          and email you the batch to hand out — each code's redemption status
          shows on your account page.
        </p>
        <form
          method="POST"
          action="/api/checkout"
          className="mt-4 flex flex-wrap items-center gap-3"
        >
          <input type="hidden" name="course" value={course.slug} />
          <input type="hidden" name="team" value="1" />
          <input type="hidden" name="next" value={`/${course.slug}`} />
          <label className="flex items-center gap-2 text-sm text-white/55">
            Seats
            <input
              type="number"
              name="seats"
              min={MIN_TEAM_SEATS}
              max={MAX_TEAM_SEATS}
              defaultValue={5}
              required
              className="h-10 w-20 rounded-[10px] border border-white/[0.12] bg-white/[0.02] px-3 text-center text-sm text-white focus:border-white/30 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            className="h-10 rounded-[10px] bg-accent px-5 font-medium text-sm text-white transition-colors hover:bg-accent-deep"
          >
            Buy team seats
          </button>
        </form>
        <p className="mt-3 text-white/40 text-xs">
          {MIN_TEAM_SEATS}–{MAX_TEAM_SEATS} seats per pack. Codes are single-use
          and never expire.
        </p>
      </div>
    </details>
  );
}

/** Post-checkout banners for the team flow (?team=success|cancelled). */
export function TeamBanner({
  status,
}: {
  status: string | undefined;
}): JSX.Element | null {
  if (status === "success") {
    return (
      <div className="mt-6 max-w-xl rounded-md border border-good/40 bg-good-tint p-4">
        <p className="font-medium text-sm text-white">
          Team codes on their way — thank you.
        </p>
        <p className="mt-1 text-sm text-white/60 leading-relaxed">
          Your unlock codes are being minted now; they arrive by email within a
          couple of minutes, one per seat, and they're also listed on your
          account page with each one's redemption status.
        </p>
      </div>
    );
  }
  if (status === "cancelled") {
    return (
      <div className="mt-6 max-w-xl rounded-md border border-white/[0.1] bg-white/[0.02] p-4">
        <p className="text-sm text-white/60">
          Team checkout cancelled — nothing was charged.
        </p>
      </div>
    );
  }
  return null;
}
