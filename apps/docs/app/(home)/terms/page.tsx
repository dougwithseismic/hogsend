import type { Metadata } from "next";
import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "The terms for using Hogsend and this site. Short, because the software is provided as is and the responsibilities are yours.",
};

const CONTACT_EMAIL = "hello@hogsend.com";

type TermsSection = {
  heading: string;
  paragraphs: (string | JSX.Element)[];
};

const SECTIONS: TermsSection[] = [
  {
    heading: "The short version",
    paragraphs: [
      "Hogsend is source-available software you run yourself. It's provided as is, without warranty of any kind. You're responsible for what you send with it, and we're not liable for what happens when you do.",
      "If that's agreeable, carry on. The detail below says the same thing more carefully.",
    ],
  },
  {
    heading: "The software",
    paragraphs: [
      "Hogsend is licensed under the Elastic License 2.0. The licence sets out what you may do with the code; these terms don't change it.",
      "The software is provided as is and as available. No warranty of merchantability, fitness for a particular purpose, or non-infringement. No guarantee it's free of defects, and no promise any defect gets fixed on a schedule — or at all.",
    ],
  },
  {
    heading: "Your responsibilities",
    paragraphs: [
      "You run your own instance, on your own infrastructure, sending from your own domain. What you send is yours: consent for your recipients, compliance with the email and privacy laws that apply to you (GDPR, PECR, CAN-SPAM, and friends), and the deliverability consequences of ignoring any of that.",
      "Don't use Hogsend to send spam. If you do, that's between you, your email provider, and the regulators — leave us out of it.",
    ],
  },
  {
    heading: "This site",
    paragraphs: [
      "The forms on this site feed a live demonstration instance. Submit an email address and you'll receive the welcome journey described next to the form — nothing undisclosed. The privacy policy covers how that data is handled.",
      "We may change, break, or remove any part of this site or the demonstration at any time, without notice.",
    ],
  },
  {
    heading: "Liability",
    paragraphs: [
      "To the maximum extent the law allows: we're not liable for any indirect, incidental, special, or consequential damage arising from the software or this site — lost profits, lost data, lost deliverability, lost weekends included. Where liability can't be excluded, it's capped at the amount you paid us, which for the software is nothing.",
    ],
  },
  {
    heading: "Changes",
    paragraphs: [
      <>
        These terms are dated 10 June 2026. If they change, the changes appear
        on this page. Questions go to{" "}
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:text-white/80"
        >
          {CONTACT_EMAIL}
        </a>
        .
      </>,
    ],
  },
];

export default function TermsPage(): JSX.Element {
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
          <Eyebrow>Terms</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-5xl text-white leading-[1.05] tracking-[-0.04em] md:text-[64px] md:leading-[1.0]">
            Terms of use
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            As is, as available, your responsibility. Last updated 10 June 2026.
          </p>
        </Reveal>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Terms body                                                        */}
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
