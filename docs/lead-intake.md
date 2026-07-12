# Lead intake — any form vendor → `lead.submitted`

Hogsend deliberately ships no form builder. Any form tool that can POST a
webhook — Heyflow, Perspective, Framer forms, Webflow, a custom React form —
becomes a lead source in three steps. The result is the canonical
**`lead.submitted`** event: identity-stitched to the visitor's browser session
(and its `campaign.arrived` ad-click touchpoints), optionally value-bearing,
idempotent across vendor webhook retries.

## The pieces

- **`@hogsend/js` plants the attribution** — on an attributed landing (click
  ID or `utm_*` in the URL) the SDK fires `campaign.arrived` and persists the
  set as last-touch. `hogsend.getAttributionFields()` returns the flat map to
  copy into the form's **hidden fields**:
  `hs_anonymous_id`, any click IDs (`fbclid`, `gclid`, …), `utm_*`,
  `hs_landing_page`, `hs_captured_at`.
- **A webhook source receives the submission** — `defineWebhookSource` +
  `buildLeadSubmission` (both exported by `@hogsend/engine`) normalize the
  vendor payload. See the reference implementation:
  `apps/api/src/webhook-sources/lead-form.ts` (served at
  `POST /v1/webhooks/lead-form`, shared-secret header auth).
- **`buildLeadSubmission` splits the fields** — `hs_anonymous_id` becomes the
  `anonymousId` identity key (top-down stitch: the email-anchored contact
  adopts the browser session, so pre-submit ad clicks and the lead land on ONE
  contact); click IDs + `utm_*` ride as flat event properties under the same
  names `campaign.arrived` uses; the remaining fields are form answers;
  `value`/`currency` (e.g. from a quote-calculator step) ride first-class on
  the event — revenue-trackable from the very first touch.

## Generic recipe (any vendor)

1. Render the form with hidden inputs populated from
   `hogsend.getAttributionFields()` (SPA: populate on mount; static HTML: a
   two-line inline script).
2. Point the vendor's webhook at
   `https://<your-api>/v1/webhooks/lead-form` with header
   `x-lead-form-secret: $LEAD_FORM_WEBHOOK_SECRET`.
3. Map the vendor's payload to the flat shape the source expects (most
   vendors already POST a flat field map):

```json
{
  "email": "lead@example.com",
  "phone": "+447700900123",
  "name": "Jane Doe",
  "submission_id": "vendor-submission-uuid",
  "value": 12500,
  "currency": "GBP",
  "own_home": "yes",
  "property_type": "detached",
  "hs_anonymous_id": "…",
  "fbclid": "…",
  "utm_source": "facebook",
  "hs_landing_page": "https://example.com/solar/quote",
  "hs_captured_at": "2026-07-12T09:00:00.000Z"
}
```

`submission_id` dedups vendor retries (`lead-submitted:<id>` idempotency key).
A payload with neither `email` nor `hs_anonymous_id` is skipped — there is no
identity to attach the lead to.

## Vendor notes

- **Heyflow** — native webhooks POST a flat answers map; hidden fields are
  "system fields"/URL-parameter fields, so `getAttributionFields()` values can
  also arrive via URL params appended to the flow link. Partial-submit
  webhooks work with the same source (send a distinct `submission_id`).
- **Perspective** — fires its webhook when a visitor converts to a lead;
  UTMs/click IDs pass through hidden fields populated from the embedding
  page's URL (Perspective forwards URL params). If the funnel lives on the
  vendor's domain, append `getAttributionFields()` as URL params on the CTA
  that links to the funnel.
- **Custom form (same page)** — skip hidden fields entirely: call
  `hogsend.capture("lead.submitted", …)`? No — POST server-side to your own
  endpoint and forward to the webhook source (or call `ingestEvent`
  directly with `buildLeadSubmission`); a browser-originated event is
  pk_-trust-tier and money-bearing conversion points should come from
  server-side sources (see docs/revenue-attribution-plan.md §5.1).

## What you get downstream

- The contact exists (email-anchored) with the browser session attached —
  `campaign.arrived` touchpoints, later email/SMS clicks, and the lead all on
  one timeline.
- `lead.submitted` is a classified touchpoint (`@hogsend/core`
  `TOUCHPOINT_EVENT_CLASSES`, channel `form`) — the attribution engine
  (plan §Phase 6) allocates conversion credit across the full path.
- Journeys can trigger on `lead.submitted` (speed-to-lead flows), and the
  CRM plugin layer (plan §Phase 4) pushes the lead into the client's CRM with
  the same canonical identity.
