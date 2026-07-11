import type { Metadata } from "next";
import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";
import { HOGSEND_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Cookies",
  description:
    "What this site stores in your browser: a sign-in session cookie and nothing else. No analytics cookies, no banner, click-to-load embeds.",
  alternates: { canonical: "/cookies" },
};

type PolicySection = {
  heading: string;
  paragraphs: (string | JSX.Element)[];
};

const SECTIONS: PolicySection[] = [
  {
    heading: "No cookie banner, because there's nothing to consent to",
    paragraphs: [
      "This site sets no analytics cookies and no third-party trackers, so EU law doesn't require a banner and we don't show one. Everything below is the complete list of what your browser stores.",
    ],
  },
  {
    heading: "If you sign in",
    paragraphs: [
      "Signing in sets a session cookie (better-auth.session_token, 30 days) plus a short-lived cache of it. These are strictly necessary — they are how the site knows you're you — and exempt from consent. Signing out removes them.",
      "Your reading progress, quiz answers, and workbook notes are stored on our server against your account, not in your browser.",
    ],
  },
  {
    heading: "Videos and podcasts",
    paragraphs: [
      "Course videos and podcast players load only when you click play. Until then nothing is fetched from YouTube or Spotify; after you click, their player runs under their own cookie policies (we use YouTube's no-cookie player). Buying a course happens on Stripe's checkout page, under Stripe's policy.",
    ],
  },
  {
    heading: "The notification bell",
    paragraphs: [
      "The bell in the nav shows course updates for signed-in readers. Its identity comes from your sign-in session — it keeps no id of its own in your browser.",
    ],
  },
  {
    heading: "The rest",
    paragraphs: [
      <>
        Data rights (access, export, deletion) live on your{" "}
        <a
          href="/account"
          className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:text-white/80"
        >
          account page
        </a>
        . The full privacy policy is at{" "}
        <a
          href={`${HOGSEND_URL}/privacy`}
          className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:text-white/80"
        >
          hogsend.com/privacy
        </a>
        .
      </>,
      "This page is dated 6 July 2026. If what we store changes, this page changes.",
    ],
  },
];

export default function CookiesPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <Section
        divider={false}
        containerClassName="container-page pt-32 pb-20 flex flex-col items-center text-center"
      >
        <Reveal className="flex flex-col items-center">
          <Eyebrow>Cookies</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-5xl text-white leading-[1.05] tracking-[-0.04em] md:text-[64px] md:leading-[1.0]">
            What this site stores
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            Short, because the answer is: a sign-in cookie, and nothing else.
          </p>
        </Reveal>
      </Section>

      <Section containerClassName="container-page py-20">
        <div className="mx-auto flex max-w-2xl flex-col gap-14">
          {SECTIONS.map((section, i) => (
            <Reveal key={section.heading} delay={(i % 3) * 0.06}>
              <section className="flex flex-col gap-4">
                <h2 className="font-medium text-white text-xl leading-[1.2] tracking-[-0.02em]">
                  {section.heading}
                </h2>
                {section.paragraphs.map((paragraph, j) => (
                  <p
                    // Static content — order never changes.
                    // biome-ignore lint/suspicious/noArrayIndexKey: static copy
                    key={j}
                    className="text-base text-white/70 leading-6"
                  >
                    {paragraph}
                  </p>
                ))}
              </section>
            </Reveal>
          ))}
        </div>
      </Section>
    </main>
  );
}
