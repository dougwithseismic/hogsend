import type { JSX } from "react";
import { CodeWindow } from "@/components/ds/code-window";
import { CONTACT_EMAIL, SITE_URL } from "@/lib/site";

/**
 * "Expense it" block: a pre-written manager-approval email in a copyable
 * file window. Most companies have a learning budget that goes unspent —
 * this removes the friction of asking. Every claim in the email must stay
 * true of the course (price, free chapters, invoice, gift codes).
 */
export function ExpenseCourse({
  courseTitle,
  courseSlug,
  priceLabel,
}: {
  courseTitle: string;
  courseSlug: string;
  priceLabel: string;
}): JSX.Element {
  const courseUrl = `${SITE_URL}/${courseSlug}`;
  const email = `Hi [manager name],

I'd like to expense a course: "${courseTitle}" — a start-to-finish
growth program for teams on PostHog. It's ${priceLabel}, one-time.

Why it's relevant to us:
- It covers instrumenting PostHog properly — an event taxonomy, a
  daily dashboard, experiments — which applies directly to our stack.
- The middle of the course is retention and lifecycle email, end to
  end: which messages to send, in what order, and how to build the
  sequence.
- It finishes with a 30/60/90/180-day plan assembled from our own
  numbers, so there's a concrete artefact at the end of it.

You can judge it before approving anything — the first two chapters
are free in full, no account needed:
${courseUrl}

It's a one-time purchase with lifetime access (no subscription), and
checkout issues a proper invoice. If it turns out to be useful, extra
copies for the team can be bought as single-use unlock codes.

Thanks,
[your name]`;

  return (
    <div>
      <CodeWindow filename="manager_email.txt" code={email} lang="text" />
      <p className="mt-5 text-center text-sm text-white/45">
        Buying for several people?{" "}
        <a href="#team" className="text-accent hover:underline">
          Get a team pack
        </a>{" "}
        — one invoice, one unlock code per seat. For anything bigger, write to{" "}
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="text-accent hover:underline"
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>
    </div>
  );
}
