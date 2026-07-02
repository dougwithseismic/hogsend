/**
 * Founder welcome — Doug, in his own voice, at the front door of a course.
 * Every line is a checkable fact: this site IS a Hogsend app (course.* events
 * feed a real Hogsend instance and its journeys), and the workbook does read
 * back as the plan in chapter 10. Server-safe (no interactivity).
 */
export function FounderNote() {
  return (
    <aside
      aria-label="A note from Doug"
      className="not-prose my-8 rounded-md border border-white/[0.08] bg-white/[0.015] p-5"
    >
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent-tint font-display text-base text-white"
        >
          D
        </span>
        <div className="min-w-0">
          <p className="font-medium text-base text-white">
            Hey — I'm Doug. I built Hogsend, and I wrote this course.
          </p>
          <p className="mt-2.5 text-sm text-white/60 leading-relaxed">
            This site is itself a Hogsend app, dogfooding what it teaches: your
            sign-up, your lesson progress, and the check-ins you answer fire
            real events into a Hogsend instance, and the emails the course sends
            you are the same kind of lifecycle journeys Chapter 5 shows you how
            to build.
          </p>
          <p className="mt-2.5 text-sm text-white/60 leading-relaxed">
            Use the workbook as you go — everything you write saves to your
            account, and by Chapter 10 it reads back as your growth plan.
            Questions along the way? Reply to any course email; they land with
            me.
          </p>
          <p className="mt-3 text-white/40 text-xs">
            — Doug Silkstone · founder, Hogsend
          </p>
        </div>
      </div>
    </aside>
  );
}
