import type { Metadata } from "next";
import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "The terms for using Hogsend, Hogsend Email, and this site. The software is provided as is; the sending service is governed by the acceptable use policy.",
  alternates: { canonical: "/terms" },
  keywords: [
    "hogsend terms of service",
    "terms of service",
    "terms and conditions",
    "hogsend email",
    "acceptable use policy",
    "lifecycle email",
    "email automation",
    "self-hosted",
    "source-available",
    "software license",
  ],
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
    heading: "Who you're contracting with",
    paragraphs: [
      'Hogsend is operated by Douglas Anthony Silkstone, a sole trader registered in the Czech Republic, business ID (IČO) 10911243. Where these terms say "we" or "us", that is who they mean.',
      `General enquiries go to ${CONTACT_EMAIL}. Abuse reports go to abuse@hogsend.com, which reaches a person rather than a queue.`,
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
    // Clause numbers 5.x: this is the fifth section on this page. The
    // internal cross-references (5.11 and 5.13 cite 5.8) must stay
    // consistent if it moves.
    heading: "Hogsend Email",
    paragraphs: [
      "5.1 What it is. Hogsend Email is a sending service included with your Hogsend Cloud subscription. We operate the sending infrastructure, hold the provider relationship, and send your mail on your behalf from a domain you verify.",
      "5.2 It is not a standalone email service. Hogsend Email is available only as part of an active Hogsend Cloud subscription, is not sold separately, and has no separate service level commitment. You may not resell it, relay third-party mail through it, or use it as a sending backend for anyone other than yourself. If your subscription ends, sending ends with it.",
      "5.3 You do not get credentials to the underlying infrastructure. Your Cloud environment holds a token that authorises it to send through us, and nothing else.",
      "5.4 Alternatives. You are not required to use Hogsend Email. Hogsend supports customer-supplied email providers, and you may configure your own provider account at any time. Mail sent that way is governed by that provider's terms, not by this clause or the Acceptable Use Policy.",
      "5.5 Allowance. Your plan includes a monthly email allowance. Sending above it is billed as overage at the published rate, or refused where your plan or trust tier sets a hard cap. Allowances and caps are stated on the pricing page and in your Cloud dashboard.",
      "5.6 Your warranty on consent. You warrant that every recipient you send to has given you permission to email them, that you can evidence that permission, and that your sending complies with the law that applies to you and to your recipients, including the UK GDPR, the EU GDPR, PECR, CAN-SPAM and CASL where applicable. You are the data controller for your recipients. We are your processor for the sending.",
      <>
        5.7 Acceptable use. The{" "}
        <a
          href="/acceptable-use"
          className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:text-white/80"
        >
          Hogsend Email Acceptable Use Policy
        </a>{" "}
        applies to all sending through the service and forms part of these
        terms. Breaching it is a breach of these terms.
      </>,
      "5.8 We may suspend sending. We may suspend sending for one of your environments immediately and without prior notice where its bounce or complaint rate crosses the thresholds in the Acceptable Use Policy, where the sending infrastructure pauses it automatically, or where we reasonably believe the Acceptable Use Policy has been breached. Because every customer sends through infrastructure we operate, one sender's reputation problem degrades delivery for everyone else, and protecting aggregate deliverability is a condition of offering the service at all.",
      "5.9 What a suspension affects. A suspension stops sending for the affected environment only. Your data, your journeys, your ingestion and the rest of your Cloud subscription continue to run. Send attempts fail with the recorded cause rather than queueing. We will tell you which clause was breached and what the measured numbers were, and there is an appeals route in the Acceptable Use Policy.",
      "5.10 No deliverability warranty. We do not warrant that any message will be delivered, will reach an inbox rather than a spam folder, or will be accepted by any mailbox provider. Inbox placement is decided by mailbox providers on signals that include your content, your list and your recipients' behaviour, none of which we control.",
      "5.11 Suspension is not a refund event. A suspension under 5.8 does not entitle you to a refund or a credit for the affected period. The rest of your subscription is unaffected and continues.",
      "5.12 On termination. When your subscription ends, sending stops, your sending identity is removed from our infrastructure, and your suppression list is retained for the period stated in the Acceptable Use Policy. You can export your suppression list before you leave, and during that period afterwards. Your domain remains yours; removing the DNS records you added is your step to take.",
      "5.13 Liability. Our total liability arising from Hogsend Email is capped at the fees you paid for the Hogsend Cloud subscription in the twelve months before the claim. We are not liable for lost revenue, lost deliverability, or the consequences of a suspension applied in accordance with 5.8.",
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
        These terms are dated 10 August 2026. If they change, the changes appear
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
            As is, as available, your responsibility. Last updated 10 August
            2026.
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
