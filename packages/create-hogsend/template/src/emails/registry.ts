import type { TemplateRegistry } from "@hogsend/email";
import ActivationNudgeEmail from "./activation-nudge.js";
import FeedbackCheckinEmail from "./feedback-checkin.js";
import MagicLinkEmail from "./magic-link.js";
import ProductUpdateEmail from "./product-update.js";
import ReceiptEmail from "./receipt.js";
import TrialExpiringEmail from "./trial-expiring.js";
import WelcomeEmail from "./welcome.js";

// Your app's template registry — CONTENT. Maps each template key to its
// component + default subject + category (+ optional preview text). Passed to
// `createHogsendClient({ email: { templates } })`, which threads it through the engine's
// `TrackedMailer` to `getTemplate(..., { registry })` at send + render time.
//
// The keys here MUST match the keys augmented into `@hogsend/email`'s
// `TemplateRegistryMap` (see `./templates.d.ts`) for `send({ template, props })`
// to type-check. They also match the `Templates` constants journeys send with
// (see `src/journeys/constants/index.ts`).
//
// These are starters covering the three send modes — add, delete, or rename
// freely. The `category` is what the mailer's suppression + frequency-cap checks
// key off:
//   - "transactional"  always delivers (exempt from list/category suppression)
//   - "journey"        normal lifecycle category
//   - a LIST id (e.g. "product-updates")  ties a broadcast to that list's opt-in
//     (see `productUpdates` in `src/lists/index.ts`)
export const templates: TemplateRegistry = {
  // Feedback — semantic yes/no links (sent from the feedback-checkin journey).
  "feedback/checkin": {
    component: FeedbackCheckinEmail,
    defaultSubject: "Quick check-in — how's it going?",
    category: "journey",
    preview: (props) => `${props.name}, one-tap question`,
  },

  // Activation (sent from the bundled `welcome` journey).
  "activation/welcome": {
    component: WelcomeEmail,
    defaultSubject: "Welcome to {{APP_NAME}}",
    category: "transactional",
    preview: (props) => `Welcome to {{APP_NAME}}, ${props.name}!`,
  },
  "activation/nudge": {
    component: ActivationNudgeEmail,
    defaultSubject: "You haven't tried the key feature yet",
    category: "journey",
    preview: (props) => `${props.name}, you're missing out`,
  },

  // Transactional — sent one-off via `hs.emails.send`.
  "transactional/magic-link": {
    component: MagicLinkEmail,
    defaultSubject: "Your sign-in link",
    category: "transactional",
    preview: () => "Your one-tap sign-in link (expires soon)",
  },
  "transactional/receipt": {
    component: ReceiptEmail,
    defaultSubject: "Your receipt",
    category: "transactional",
    preview: (props) => `Receipt ${props.invoiceNumber} — ${props.amount}`,
  },

  // Lifecycle — sent from the bundled `trial-expiring` journey.
  "lifecycle/trial-expiring": {
    component: TrialExpiringEmail,
    defaultSubject: "Your trial is ending soon",
    category: "journey",
    preview: (props) =>
      `${props.daysLeft ?? 3} day${(props.daysLeft ?? 3) === 1 ? "" : "s"} left in your trial`,
  },

  // Marketing — broadcast to a list via `hs.campaigns.send`.
  // `category` MUST match the list id so suppression respects the opt-in.
  "marketing/product-update": {
    component: ProductUpdateEmail,
    defaultSubject: "What's new at {{APP_NAME}}",
    category: "product-updates",
    preview: (props) => props.headline,
  },
};
