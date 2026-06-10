import type { Metadata } from "next";
import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What Hogsend collects, what it's used for, where it lives, and how to get it removed.",
};

const PRIVACY_EMAIL = "hello@hogsend.com";

type PolicySection = {
  heading: string;
  paragraphs: (string | JSX.Element)[];
};

const SECTIONS: PolicySection[] = [
  {
    heading: "What we collect",
    paragraphs: [
      "If you submit a form on this site, we collect your email address and, if you give one, your first name. That's the lot.",
      "We also run anonymous product analytics on the site — page views and the like. No cookies, no cross-site tracking, no profiles. We can't tell who you are from it and we don't try.",
    ],
  },
  {
    heading: "What we do with it",
    paragraphs: [
      "Your email address gets you the welcome journey you asked for. Product notes are a separate list you can opt into from the preference centre linked in every email — we never add you to it ourselves.",
      "Every email we send carries a one-click unsubscribe and a link to a preference centre. Both work immediately and neither asks why.",
    ],
  },
  {
    heading: "Where it lives",
    paragraphs: [
      "A few processors handle data on our behalf: Resend delivers email (EU region). Railway hosts the application. Cloudflare handles DNS and inbound email. PostHog EU stores the anonymous analytics, and only when analytics is enabled.",
      "That's the full list. If it changes, this page changes.",
    ],
  },
  {
    heading: "Your rights",
    paragraphs: [
      <>
        You can ask what we hold about you, ask us to correct it, or ask us to
        delete it. Email{" "}
        <a
          href={`mailto:${PRIVACY_EMAIL}`}
          className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:text-white/80"
        >
          {PRIVACY_EMAIL}
        </a>{" "}
        and it gets handled.
      </>,
      "Unsubscribing doesn't need an email to anyone — the link in every message does it on the spot.",
    ],
  },
  {
    heading: "What we don't do",
    paragraphs: [
      "We don't sell your data. We don't use third-party ad tech. The analytics is cookieless, so there's no consent banner because there's nothing to consent to.",
    ],
  },
  {
    heading: "Changes",
    paragraphs: [
      "This policy is dated 10 June 2026. If it changes, the changes appear on this page.",
    ],
  },
];

export default function PrivacyPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* ---------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ---------------------------------------------------------------- */}
      <Section
        divider={false}
        containerClassName="container-page pt-32 pb-20 flex flex-col items-center text-center"
      >
        <Reveal className="flex flex-col items-center">
          <Eyebrow>Privacy</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-5xl text-white leading-[1.05] tracking-[-0.04em] md:text-[64px] md:leading-[1.0]">
            Privacy policy
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            Short, because there isn't much to disclose. Last updated 10 June
            2026.
          </p>
        </Reveal>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Policy body                                                       */}
      {/* ---------------------------------------------------------------- */}
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
