/**
 * The legal pages, as data.
 *
 * DRAFT on purpose: nothing here has been through a lawyer. Every paragraph is
 * a statement about what the software ACTUALLY does today — the control plane
 * schema, the encryption in `crypto.ts`, the region rule in `regions.ts` — so
 * the stub is useful (a customer can read what happens to their data) and the
 * lawyer pass has facts to write against rather than boilerplate to correct.
 * The clauses only a lawyer can write are listed as `pending` sections rather
 * than invented; a made-up liability cap would be worse than an empty one.
 *
 * Holding it as data (not JSX) means the pages, their metadata and the tests
 * read one source, so a section cannot exist in the page but not the contract.
 */

export type LegalSection = {
  heading: string;
  /** Paragraphs, in order. Plain text — no markup is interpreted. */
  body: readonly string[];
};

export type LegalDocument = {
  slug: "terms" | "privacy";
  path: `/${string}`;
  title: string;
  /** One factual line under the title. */
  summary: string;
  /** What state this document is in — rendered next to the DRAFT badge. */
  status: string;
  sections: readonly LegalSection[];
  /** Clauses that need a lawyer, named so their absence is visible. */
  pending: readonly string[];
};

/** Both legal routes are public; the guard reads this list. */
export const LEGAL_PATHS = ["/terms", "/privacy"] as const;

const TERMS: LegalDocument = {
  slug: "terms",
  path: "/terms",
  title: "Terms of service",
  summary:
    "What Hogsend Cloud does, what it expects of you, and what it does not yet promise.",
  status:
    "This draft describes how the product behaves today. It has not been reviewed by a lawyer and is not a contract.",
  sections: [
    {
      heading: "What the service is",
      body: [
        "Hogsend Cloud is a control plane. It creates and operates managed Hogsend instances on your behalf: an organization owns environments, and each environment is one instance with its own database, worker and API URL.",
        "Hogsend itself is source-available under the Elastic License 2.0. Running it yourself is always an option; this service is the hosted alternative.",
      ],
    },
    {
      heading: "Accounts and organizations",
      body: [
        "An account is one email address. An organization is created by one person, who holds the owner role, and can invite others as admin or member. Owners and admins can invite, remove and re-role members; a member can only read.",
        "Every organization starts on a 14-day trial with one production environment. Paid plans are not chargeable yet, so no plan changes are offered in the product.",
      ],
    },
    {
      heading: "Your data and your credentials",
      body: [
        "You supply the provider keys the instance sends with — Resend, Postmark, PostHog, Twilio and the like. They are stored encrypted and used only to operate your environments.",
        "Contact data you ingest or upload is yours. You are responsible for having a lawful basis to hold it and to message the people in it, including consent where the channel requires it (SMS in particular).",
        "You remain bound by the terms of the providers whose keys you supply. Nothing here overrides them.",
      ],
    },
    {
      heading: "Availability and support",
      body: [
        "No uptime target is published, because none is being measured yet. Do not read a service level into this document that it does not state.",
      ],
    },
    {
      heading: "Ending the relationship",
      body: [
        "Deleting your account, when you are an organization's sole owner, marks that organization suspended for deletion and signs you out. The record is kept until the deletion flow runs; it is not an immediate erase, and the product says so at the point of the action.",
        "We may suspend an organization that is being used to send messages to people who did not agree to receive them.",
      ],
    },
    {
      heading: "Changes to this document",
      body: [
        "This page carries a DRAFT badge until a lawyer has reviewed it. When that happens the badge comes off and this section will say how changes are notified.",
      ],
    },
  ],
  pending: [
    "Warranties and disclaimers",
    "Limitation of liability",
    "Indemnity",
    "Fees, billing, renewals and refunds",
    "Service level and support commitments",
    "Governing law and dispute resolution",
  ],
};

const PRIVACY: LegalDocument = {
  slug: "privacy",
  path: "/privacy",
  title: "Privacy",
  summary:
    "What the control plane stores, where it stores it, and what it does not do with it.",
  status:
    "This draft states current behaviour of the software. It has not been reviewed by a lawyer and is not yet a privacy notice you can rely on for compliance.",
  sections: [
    {
      heading: "What the control plane stores about you",
      body: [
        "Your account: email address, a password hash, whether the address is verified, and your active sessions. Passwords are never stored in a readable form.",
        "Your organizations: name, region, plan, membership and role, pending invitations, and the environments and stacks that belong to them.",
        "An audit log of control-plane actions — who did what, and when. It exists so an organization can answer that question about itself.",
      ],
    },
    {
      heading: "Per-tenant isolation",
      body: [
        "Your environment's data lives in a database provisioned for that environment, not in a shared table keyed by a tenant column. The control plane holds the account and organization records described above; your contacts, events and sends live in your own instance.",
      ],
    },
    {
      heading: "Provider keys are encrypted at rest",
      body: [
        "Third-party credentials you supply are encrypted before they are written, using AES-256-GCM with a key derived from a control-plane secret, and are decrypted only to operate your environments. A tampered or truncated value fails closed rather than returning a partial secret.",
      ],
    },
    {
      heading: "Region choice",
      body: [
        "You pick European Union or United States when you create an organization, and the data stays in that region's infrastructure. The region is fixed at creation: moving a tenant between regions is a migration, not a setting.",
      ],
    },
    {
      heading: "What we do not do",
      body: [
        "Your data is not sold, and it is not shared with advertisers or data brokers.",
        "The control plane runs no analytics, advertising or session-recording scripts. It sets one cookie, the session cookie that keeps you signed in.",
      ],
    },
    {
      heading: "Email we send you",
      body: [
        "Verification codes, invitations and account notices. In development these are written to the server log rather than sent; in production they go out through our own email provider, not through a key of yours.",
      ],
    },
  ],
  pending: [
    "Named subprocessors and their locations",
    "Retention periods per data category",
    "Data subject rights and how to exercise them",
    "Data processing agreement and standard contractual clauses",
    "Breach notification commitments",
    "Contact point for privacy requests",
  ],
};

export const LEGAL_DOCUMENTS = { terms: TERMS, privacy: PRIVACY } as const;
