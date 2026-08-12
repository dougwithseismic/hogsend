import type { Metadata } from "next";
import { Fragment, type JSX, type ReactNode } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "Acceptable Use Policy",
  description:
    "The Hogsend Email acceptable use policy: consent, prohibited use, the sending thresholds and trust tiers, and how suspension and appeals work.",
  alternates: { canonical: "/acceptable-use" },
  keywords: [
    "hogsend email acceptable use policy",
    "acceptable use policy",
    "aup",
    "email sending policy",
    "anti-spam policy",
    "bounce rate threshold",
    "complaint rate threshold",
    "sender reputation",
    "email suspension",
  ],
};

const ABUSE_EMAIL = "abuse@hogsend.com";

const BODY_CLASS = "text-base text-white/70 leading-6";
const NOTE_CLASS = "text-sm text-white/50 leading-6";
const CELL_HEAD_CLASS = "py-2 pr-4 font-medium text-white";
const CELL_CLASS = "py-2 pr-4 align-top";

type PolicySection = {
  heading: string;
  paragraphs: (string | JSX.Element)[];
};

/** A numbered clause. The clause numbers are load-bearing: suspension notices
 *  cite them verbatim, so they must match the approved policy text exactly. */
function clause(id: string, body: ReactNode): JSX.Element {
  return (
    <p className={BODY_CLASS}>
      <strong className="font-medium text-white">{id}</strong> {body}
    </p>
  );
}

/** A bold lead phrase inside a clause, mirroring the source's emphasis. */
function lead(text: string): JSX.Element {
  return <strong className="font-medium text-white">{text}</strong>;
}

/** The observability stanza under a clause: the signal that detects a breach
 *  and the clause that enforces it. */
function signal(signalText: ReactNode, enforcement: ReactNode): JSX.Element {
  return (
    <p className={NOTE_CLASS}>
      <em>Signal:</em> {signalText} <em>Enforcement:</em> {enforcement}
    </p>
  );
}

function abuseLink(): JSX.Element {
  return (
    <a
      href={`mailto:${ABUSE_EMAIL}`}
      className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:text-white/80"
    >
      {ABUSE_EMAIL}
    </a>
  );
}

const RATE_TABLE = (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse text-left text-sm">
      <thead>
        <tr className="border-white/15 border-b">
          <th className={CELL_HEAD_CLASS}>Metric</th>
          <th className={CELL_HEAD_CLASS}>Required</th>
          <th className={CELL_HEAD_CLASS}>Sending is suspended at</th>
        </tr>
      </thead>
      <tbody className="text-white/70">
        <tr className="border-white/10 border-b">
          <td className={CELL_CLASS}>Hard bounce rate</td>
          <td className={CELL_CLASS}>below 5%</td>
          <td className={CELL_CLASS}>5% or greater</td>
        </tr>
        <tr>
          <td className={CELL_CLASS}>Complaint rate</td>
          <td className={CELL_CLASS}>below 0.1%</td>
          <td className={CELL_CLASS}>0.1% or greater</td>
        </tr>
      </tbody>
    </table>
  </div>
);

const TIER_TABLE = (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse text-left text-sm">
      <thead>
        <tr className="border-white/15 border-b">
          <th className={CELL_HEAD_CLASS}>Tier</th>
          <th className={CELL_HEAD_CLASS}>Entered by</th>
          <th className={CELL_HEAD_CLASS}>Automated enforcement</th>
          <th className={CELL_HEAD_CLASS}>Send cap</th>
          <th className={CELL_HEAD_CLASS}>Bulk import</th>
        </tr>
      </thead>
      <tbody className="text-white/70">
        <tr className="border-white/10 border-b">
          <td className={CELL_CLASS}>new</td>
          <td className={CELL_CLASS}>at provisioning</td>
          <td className={CELL_CLASS}>observed, no automatic pause</td>
          <td className={CELL_CLASS}>low daily cap</td>
          <td className={CELL_CLASS}>blocked</td>
        </tr>
        <tr className="border-white/10 border-b">
          <td className={CELL_CLASS}>established</td>
          <td className={CELL_CLASS}>
            clean sending over a defined volume and window
          </td>
          <td className={CELL_CLASS}>pause on high-severity findings</td>
          <td className={CELL_CLASS}>plan allowance</td>
          <td className={CELL_CLASS}>allowed</td>
        </tr>
        <tr>
          <td className={CELL_CLASS}>watched</td>
          <td className={CELL_CLASS}>
            automatically, on any reputation finding
          </td>
          <td className={CELL_CLASS}>
            pause on any finding, including low severity
          </td>
          <td className={CELL_CLASS}>reduced</td>
          <td className={CELL_CLASS}>blocked</td>
        </tr>
      </tbody>
    </table>
  </div>
);

const SECTIONS: PolicySection[] = [
  {
    heading: "1. Scope",
    paragraphs: [
      clause(
        "1.1",
        "This policy governs all email sent through Hogsend Email, the sending service bundled with Hogsend Cloud. It applies to you, to anyone you give access to your Hogsend Cloud organization, and to any system you connect to it.",
      ),
      clause(
        "1.2",
        "Enforcement is per environment. One Hogsend Cloud environment is one isolated sending tenant with its own reputation, its own suppression list and its own sending status. Suspending one environment does not affect any other environment, including your own.",
      ),
      clause(
        "1.3",
        <>
          This policy is incorporated into the{" "}
          <a
            href="/terms"
            className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:text-white/80"
          >
            Hogsend Cloud terms
          </a>
          . Breaching it is a breach of those terms.
        </>,
      ),
      clause(
        "1.4",
        "This policy does not apply to email you send through your own provider account. If you supply your own Resend or Postmark credentials, your relationship is with that provider and their policy governs it.",
      ),
    ],
  },
  {
    heading: "2. Consent",
    paragraphs: [
      clause(
        "2.1",
        "You may only send to recipients who gave you their email address directly and who would recognise you as the sender.",
      ),
      signal(
        `complaint rate, spamtrap reports relayed to us by AWS Trust and Safety, direct recipient reports to ${ABUSE_EMAIL}.`,
        "§6.",
      ),
      clause(
        "2.2",
        "You may not send to purchased, rented, scraped, appended, or otherwise third-party-sourced lists. Buying a list is a breach whether or not the sending that follows performs well.",
      ),
      signal(
        "bounce rate on a newly imported list against a tenant with no prior sending history; sudden volume with no matching contact-creation history; spamtrap hits.",
        "bulk list import is blocked below the established tier under §5.3, which is a structural block rather than a detection. A finding after import triggers §6.1.",
      ),
      clause(
        "2.3",
        "Bulk imports must record where the addresses came from and when consent was given. Imports without that record may be refused.",
      ),
      signal(
        "the import declaration, captured at import time.",
        "the import is refused. Repeated refusal attempts are reviewed under §6.4.",
      ),
      clause(
        "2.4",
        "You may not send to an address after that recipient has unsubscribed, however they did it.",
      ),
      signal(
        "enforced in software. Every send passes one preference and suppression check before dispatch; an unsubscribed recipient produces a recorded skip, not a delivery. Attempting to send to an unsubscribed recipient is visible in your own send log.",
        "automatic and permanent at the send path. Deliberately circumventing it, for example by re-importing suppressed addresses under a new identifier, is a breach under §3.7.",
      ),
      clause(
        "2.5",
        "Every marketing message must carry a working unsubscribe link and a working List-Unsubscribe header. Both are added automatically. You may not remove, obscure, or redirect them to a page that does not unsubscribe.",
      ),
      signal(
        "templates are rendered through our pipeline, so a missing or altered unsubscribe target is observable at send time.",
        "§6.",
      ),
    ],
  },
  {
    heading: "3. Prohibited use",
    paragraphs: [
      clause("3.1", "Unsolicited bulk email, in any volume."),
      signal(
        "complaint rate under §5.1, AWS reputation findings, direct reports.",
        "§6.1 or §6.2.",
      ),
      clause(
        "3.2",
        "Phishing, credential harvesting, or impersonating another person, brand, or organisation. This includes impersonating Hogsend, Amazon, or any payment provider.",
      ),
      signal(
        "recipient reports, mailbox provider feedback relayed by AWS, blocklist notifications naming a domain in your message content.",
        "§6.2, immediate and permanent. There is no appeal for this clause.",
      ),
      clause(
        "3.3",
        "Distributing malware, exploit payloads, or links to either.",
      ),
      signal(
        "domain blocklist notifications from AWS, recipient reports.",
        "§6.2, immediate and permanent. There is no appeal for this clause.",
      ),
      clause(
        "3.4",
        "Content that is unlawful where the recipient is, or that promotes unlawful goods or services.",
      ),
      signal(
        "recipient reports, regulator or mailbox provider contact, AWS Trust and Safety case.",
        "§6.2.",
      ),
      clause(
        "3.5",
        "These categories require written approval before you send them, because they carry structurally high complaint rates regardless of how the list was built: adult content, gambling, short-term and payday lending, debt relief, cryptocurrency and token promotion, multi-level marketing and business-opportunity offers, and pharmaceuticals.",
      ),
      signal(
        "the category is declared at signup or observed in message content following a report. Complaint rate is the leading indicator either way.",
        "sending in an unapproved category is §6.2. Approved senders in these categories are held on the watched tier under §5.2.",
      ),
      clause(
        "3.6",
        "You may only send from a domain you control and have verified. Verification is a DNS record you place yourself.",
      ),
      signal(
        "enforced in software. An unverified identity cannot send.",
        "structural. There is nothing to detect.",
      ),
      clause(
        "3.7",
        "You may not forge headers, misrepresent the sender, use a misleading subject line, or use technical means to evade suppression, unsubscribe handling, rate limits, or sending caps.",
      ),
      signal(
        "the From address is constrained to a verified identity, so forgery attempts fail at the send path and are logged. Suppression evasion shows as a re-import of addresses already suppressed for this environment.",
        "§6.2.",
      ),
      clause(
        "3.8",
        "You may not resell Hogsend Email as a standalone sending service, relay mail on behalf of a third party, or use your environment as a shared sending account for senders who are not you. Hogsend Email is a feature of your Cloud subscription, not an email API you can put a wrapper around.",
      ),
      signal(
        "sends whose From domain is not an identity verified to your environment are impossible. The observable pattern is many unrelated sending domains verified against one environment, or recipient reports naming a brand that is not yours.",
        "§6.2.",
      ),
    ],
  },
  {
    heading: "4. Volume and rate",
    paragraphs: [
      clause(
        "4.1",
        "Each environment has a sending cap set by its plan and its trust tier under §5. Sends above the cap are refused, not queued.",
      ),
      signal(
        "metered per environment, per billing period.",
        "automatic refusal at the send path, with the reason stated.",
      ),
      clause(
        "4.2",
        "You may not split sending across multiple environments or organizations to defeat a cap or a suspension.",
      ),
      signal(
        "a new environment or organization created with the same billing identity, domain, or recipient list shortly after a suspension.",
        "§6.4, applied to every linked environment.",
      ),
    ],
  },
  {
    heading: "5. Reputation thresholds and trust tiers",
    paragraphs: [
      clause(
        "5.1",
        <>
          {lead("Rates you must stay inside.")} Measured over a representative
          volume of your recent sending:
        </>,
      ),
      RATE_TABLE,
      "These are the levels at which Amazon Web Services places an entire sending account under review, and at 10% bounce or 0.5% complaint it may pause the account outright. Because every Hogsend Email tenant sends through infrastructure we own, one tenant reaching those levels puts every other customer's mail at risk. We therefore suspend at the review threshold rather than the pause threshold.",
      signal(
        "bounce and complaint rates reported per tenant by the sending infrastructure, plus reputation findings raised against the tenant.",
        "§6.1.",
      ),
      clause(
        "5.2",
        <>
          {lead("Trust tiers.")} Every environment sits in one tier. The tier
          sets the automated enforcement level applied by the sending
          infrastructure, the sending cap, and whether bulk import is available.
        </>,
      ),
      TIER_TABLE,
      "Promotion to established is automatic once the criteria are met. Demotion to watched is automatic and immediate. Promotion out of watched is a human review, never automatic.",
      signal(
        "sending volume, window, bounce rate and complaint rate per tenant; reputation findings.",
        "the tier change applies the corresponding enforcement level and cap without further notice.",
      ),
      clause(
        "5.3",
        <>
          {lead("New and watched environments cannot bulk import a list.")} This
          is not a rate limit, it is a block. An environment with no established
          sending record cannot perform a large first send to a list we have
          never seen.
        </>,
      ),
      signal(
        "structural. The import is refused with the tier requirement named.",
        "the refusal is the enforcement.",
      ),
    ],
  },
  {
    heading: "6. Suspension and appeals",
    paragraphs: [
      clause(
        "6.1",
        <>
          {lead("Suspension may be automatic and immediate.")} When the sending
          infrastructure detects a reputation problem at the level your tier
          enforces, or when a rate in §5.1 is crossed, sending for that
          environment stops without prior notice and without human involvement.
          We do not warn first. A warning period at those rates is measured in
          tens of thousands of messages already delivered.
        </>,
      ),
      clause(
        "6.2",
        <>
          {lead("We may also suspend an environment manually")}, immediately and
          without notice, on evidence of a breach of §2 or §3, or where
          continued sending would put the deliverability of other customers at
          risk.
        </>,
      ),
      clause(
        "6.3",
        <>
          {lead("What a suspension does.")} Sending for the environment fails
          closed. Every send attempt returns an explicit paused status naming
          the recorded cause; nothing is silently queued, retried, or rerouted.
          Your journeys record the reason. A suspended environment cannot switch
          to its own provider credentials to keep sending. Everything else in
          the environment keeps running: ingestion, journeys, data, and the API.
        </>,
      ),
      clause(
        "6.4",
        <>
          {lead("Repeat breaches.")} A second suspension for the same clause, or
          evidence of deliberate evasion under §3.7 or §4.2, ends sending on
          that environment permanently and may end the Hogsend Cloud
          subscription.
        </>,
      ),
      clause(
        "6.5",
        <>
          {lead("Notice.")} We send a notice to the environment's owner once per
          suspension. It states the clause breached, the measured numbers behind
          the decision, and what to do next.
        </>,
      ),
      clause(
        "6.6",
        <>
          {lead("Appeals.")} Reply to the suspension notice, or write to{" "}
          {abuseLink()} from the environment owner's address. An appeal is
          reviewed by a person. Reinstatement is never automatic and is never
          granted on request alone: it requires the cause to be resolved,
          because sending resumed over an unresolved cause pauses again within
          days and the second pause is worse than the first.
        </>,
      ),
      "Tell us, in the reply:",
      <ol
        key="appeal-steps"
        className={`list-decimal pl-5 ${BODY_CLASS} flex flex-col gap-2`}
      >
        <li>What caused the bounces or complaints.</li>
        <li>What you changed.</li>
        <li>
          What list you will send to when sending resumes, and where those
          addresses came from.
        </li>
      </ol>,
      clause(
        "6.7",
        <>
          {lead("No appeal is available under §3.2 or §3.3.")} Phishing and
          malware end sending permanently.
        </>,
      ),
      clause(
        "6.8",
        <>
          {lead("Response time.")} We aim to give an initial response to an
          appeal within one working day.
        </>,
      ),
    ],
  },
  {
    heading: "7. Suppression lists and data retention",
    paragraphs: [
      clause(
        "7.1",
        "Each environment has its own suppression list. Bounces and complaints from your sending suppress the address for your environment only, and never for another customer.",
      ),
      clause(
        "7.2",
        "Addresses that hard bounce or file a complaint are added to your suppression list automatically and are excluded from all future sends from your environment.",
      ),
      clause(
        "7.3",
        "You cannot remove an address that was suppressed for a complaint. A recipient who reports your mail as spam has made a decision, and re-sending to them is the fastest route to §5.1.",
      ),
      clause(
        "7.4",
        "You may remove an address suppressed for a hard bounce, on the understanding that the bounce counts against §5.1 again if it recurs. Repeatedly clearing and re-sending to the same bouncing address is evasion under §3.7.",
      ),
      clause(
        "7.5",
        "Unsubscribe and suppression records are retained for the life of the environment, and for 12 months after the environment is deleted. They are retained even where you delete the underlying contact, because the record of a withdrawn consent is what proves the withdrawal was honored, and deleting it would let the same address be re-imported and mailed again.",
      ),
      clause(
        "7.6",
        "You can export your suppression list at any time while the environment exists. Ask, and we will export it after deletion within the 12-month window in §7.5.",
      ),
    ],
  },
  {
    heading: "8. Reports and changes",
    paragraphs: [
      clause(
        "8.1",
        <>
          Report abuse of Hogsend Email, including mail you received from a
          Hogsend customer, to {abuseLink()}. Include full message headers.
        </>,
      ),
      clause(
        "8.2",
        "We may change this policy. Material changes are notified to Cloud account owners before they take effect. The current version is always the one at this address, and it is dated.",
      ),
    ],
  },
];

export default function AcceptableUsePage(): JSX.Element {
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
          <Eyebrow>Hogsend Email</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-5xl text-white leading-[1.05] tracking-[-0.04em] md:text-[64px] md:leading-[1.0]">
            Acceptable use policy
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            Every clause below maps to a signal we can observe or to a named
            enforcement action. A rule we cannot detect is noise that weakens
            the ones we can, so there are no aspirational clauses here. Last
            updated 10 August 2026.
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
                  <Fragment
                    // Static content — order never changes.
                    // biome-ignore lint/suspicious/noArrayIndexKey: static copy
                    key={j}
                  >
                    {typeof paragraph === "string" ? (
                      <p className={BODY_CLASS}>{paragraph}</p>
                    ) : (
                      paragraph
                    )}
                  </Fragment>
                ))}
              </section>
            </Reveal>
          ))}
        </div>
      </Section>
    </main>
  );
}
