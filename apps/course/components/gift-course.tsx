import { Gift } from "lucide-react";
import type { JSX } from "react";
import type { CourseMeta } from "@/lib/courses";

/**
 * Gift-a-copy affordance for a purchasable course: a zero-JS disclosure with
 * a plain form into /api/checkout's gift mode. The buyer pays the course
 * price; the webhook mints a single-use 100%-off code and the lifecycle
 * emails deliver it — to the recipient directly when an email is given, else
 * to the buyer to forward. Signed-out buyers bounce through sign-in.
 */
export function GiftCourse({ course }: { course: CourseMeta }): JSX.Element {
  return (
    <details
      id="gift"
      className="group mt-6 max-w-xl scroll-mt-28 rounded-md border border-white/[0.08] bg-white/[0.015]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 p-4 text-sm text-white/70 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
        <Gift className="size-4 text-accent" strokeWidth={1.5} aria-hidden />
        <span className="font-medium">
          Gift this course to someone
          {course.priceLabel ? ` — ${course.priceLabel}` : ""}
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
          Know someone on your team who should work through this? You pay for
          one copy and we mint a single-use unlock code — emailed straight to
          them if you give us their address, or to you to forward.
        </p>
        <form
          method="POST"
          action="/api/checkout"
          className="mt-4 flex flex-wrap items-center gap-3"
        >
          <input type="hidden" name="course" value={course.slug} />
          <input type="hidden" name="gift" value="1" />
          <input type="hidden" name="next" value={`/${course.slug}`} />
          <input
            type="email"
            name="recipientEmail"
            placeholder="their@email.com (optional)"
            className="h-10 min-w-[220px] flex-1 rounded-[10px] border border-white/[0.12] bg-white/[0.02] px-3 text-sm text-white placeholder:text-white/35 focus:border-white/30 focus:outline-none"
          />
          <button
            type="submit"
            className="h-10 rounded-[10px] bg-accent px-5 font-medium text-sm text-white transition-colors hover:bg-accent-deep"
          >
            Gift it{course.priceLabel ? ` — ${course.priceLabel}` : ""}
          </button>
        </form>
      </div>
    </details>
  );
}

/** Post-checkout banners for the gift flow (?gift=success|cancelled). */
export function GiftBanner({
  status,
}: {
  status: string | undefined;
}): JSX.Element | null {
  if (status === "success") {
    return (
      <div className="mt-6 max-w-xl rounded-md border border-good/40 bg-good-tint p-4">
        <p className="font-medium text-sm text-white">
          🎁 Gift on its way — thank you.
        </p>
        <p className="mt-1 text-sm text-white/60 leading-relaxed">
          The single-use unlock code is being minted now; it arrives by email
          within a couple of minutes (to your recipient if you gave us their
          address, otherwise to you to forward).
        </p>
      </div>
    );
  }
  if (status === "cancelled") {
    return (
      <div className="mt-6 max-w-xl rounded-md border border-white/[0.1] bg-white/[0.02] p-4">
        <p className="text-sm text-white/60">
          Gift checkout cancelled — nothing was charged.
        </p>
      </div>
    );
  }
  return null;
}
