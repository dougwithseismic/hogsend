import { ArrowRight } from "lucide-react";
import { ALL_ACCESS, getCourse } from "@/lib/courses";
import { allAccessConfigured } from "@/lib/entitlements";

/**
 * Wall shown to a SIGNED-IN reader who hasn't purchased the course. Renders the
 * lesson's title/description as a teaser, never the body (the gate returns this
 * before the MDX is read). The Buy button is a plain HTML form POST to
 * /api/checkout — no client JS — carrying the course slug and the return path.
 */
export function Paywall({
  course,
  lessonUrl,
  title,
  description,
}: {
  course: string;
  lessonUrl: string;
  title: string;
  description?: string;
}) {
  const meta = getCourse(course);
  const price = meta?.priceLabel ?? "";
  return (
    <div className="container-page py-16 md:py-24">
      <p className="kicker mb-3">{meta?.title ?? "Full course"}</p>
      <h1 className="max-w-2xl font-display text-[32px] leading-[1.1] tracking-[-0.03em] md:text-[40px]">
        {title}
      </h1>
      {description ? (
        <p className="mt-4 max-w-xl text-lg text-white/60 leading-7">
          {description}
        </p>
      ) : null}

      <div className="mt-8 max-w-xl rounded-md border border-white/[0.08] bg-white/[0.015] p-6">
        <p className="text-white/80">
          The first lesson is free. Unlock the full course
          {meta?.title ? ` — ${meta.title}` : ""} with a one-time purchase.
        </p>
        <p className="mt-1 text-sm text-white/50">
          Lifetime access to every lesson, on this account. No subscription.
        </p>

        <form method="post" action="/api/checkout" className="mt-5">
          <input type="hidden" name="course" value={course} />
          <input type="hidden" name="next" value={lessonUrl} />
          <button
            type="submit"
            className="group inline-flex h-12 select-none items-center gap-2 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-base tracking-[-0.02em] transition-colors duration-200 hover:bg-white/90"
          >
            <span>
              {price ? `Unlock the course — ${price}` : "Unlock the course"}
            </span>
            <ArrowRight
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5"
              strokeWidth={2}
            />
          </button>
        </form>

        <p className="mt-4 text-sm text-white/40">
          Buying for someone else?{" "}
          <a
            href={`/${course}#gift`}
            className="text-white/60 underline transition-colors hover:text-white"
          >
            Gift a copy instead →
          </a>
        </p>

        {allAccessConfigured() ? (
          <div className="mt-5 border-white/[0.08] border-t pt-5">
            <p className="text-sm text-white/50">
              Taking more than one course?
            </p>
            <form method="post" action="/api/checkout" className="mt-1">
              <input type="hidden" name="course" value={ALL_ACCESS.slug} />
              <input type="hidden" name="next" value={lessonUrl} />
              <button
                type="submit"
                className="text-accent text-sm transition-colors hover:underline"
              >
                Get All-Access — {ALL_ACCESS.priceLabel} — every course →
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </div>
  );
}
