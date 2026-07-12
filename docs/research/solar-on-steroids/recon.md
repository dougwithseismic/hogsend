# Solar on Steroids — primary recon (browser, 2026-07-12)

First-hand evidence gathered in-browser from solaronsteroids.com + its public API. Everything here was directly observed; inference is marked.

## What the business is

**Solar on steroids Ltd** (Companies House 15845416, Manchester, founded 2024) — a UK marketing agency for solar/renewables installers. NOT a lead marketplace: leads are generated in the client's name, into the client's CRM, from the client's own ad account. "54/60 UK clients", "40+ team members", expanding to the US ("be one of our first 10 US installers") and beyond solar (`/call/uk-windows` booking route exists).

Header claim: "Responsible for £25M+ in residential solar sales". Case study (Activ8 Energies, Ireland's largest installer): performance bet — free shoot, waived setup fee, £3k gifted ad spend, paid only if results improved >3x; delivered ~5x, CPL −79%.

## The five-part machine (from /service)

1. **Trust layer** — they build a page per client that collects authentic *self-shot selfie video testimonials* from the installer's customers; those become the ad creative ("turning your customers into your sales team").
2. **Meta video ads** — plan/shoot/edit/launch/manage. Anti-price-shopper positioning (an ad literally opened "Looking for cheap solar? Go find someone else!"). Hundreds of shoots; repeat shoots per client every ~3–5 months (Kimble Solar: Feb/Jul/Oct 2025).
3. **Quiz funnels on Perspective** (perspective.co) — SOS is Perspective's *first and #1 agency partner*; 30,000+ leads generated through it; £200k/month of client traffic. Multi-step, conditional logic, dynamic headlines matched to the ad, **autofill deliberately disabled** (forces typed, current contact data). Argument: funnels > Meta lead forms because friction = intent.
4. **"On steroids API" attribution system** — see below. Optimises campaigns on cost per **quote/sale**, not cost per lead, by feeding CRM outcomes back to Meta CAPI.
5. **Direct CRM integrations** — GoHighLevel, HubSpot, Salesforce, Monday, Pipedrive, Payaca, "bespoke if API is available".

## The attribution system (from /service/data)

Built by Jude Cornish (CCO) + a "technical VA". Four datapoints: **initial submission info, session tracking, pipeline stage/status, deal value**.

Simulated system log shown on the page (verbatim trace, their own illustration of the pipeline):

```
crm.poll — checking for stage changes
POST /webhooks/crm 200 — 41ms
crm.webhook received
uid:a7f3
status:survey_booked → sold
deal.value: £17,124
session.lookup uid: a7f3
fb_click_id:23849710234
ad_id:120214189432870187 matched
ad: "Ecoflow taking the UK by storm"
time_to_close: 4 days 3 hrs 12 mins
capi.event lead_sold  value: £17,124
capi.event dispatched → facebook.com
capi.response 200 success
meta.signal confirmed
```

Notes: they run **both** CRM webhooks and polling; identity is a session **uid** joined to `fb_click_id` + `ad_id`; the CAPI event is a custom `lead_sold` with deal value.

Tracked fields listed verbatim on the page:
`appeal, product, ipAddress, dealValue, sold, quoted, pipelineStage, perspectiveId, funnelStartPage, sosId, crmId, clientId, dateCreated, lastUpdated, utm_medium, utm_id, utm_campaign, utm_source, postcode, phone, email, name`

Cross-channel claim: an FB ad click without a form fill, followed later by a direct/organic site visit that converts, is stitched back to the first touchpoint (first-touch stitching across sessions).

GDPR posture: tracking via UIDs; **no PII stored beyond 29 days**; clients control how much of their data is published; sub-processor list available for DPIA.

**They sell the system itself** to other agencies/service businesses for **£40,000–£100,000 +VAT** ("Our competitors literally cannot compete with our IP").

## The live data feed (marketing weapon)

Every page carries live counters + toast notifications ("Mutant#YMQE sold one of our leads a £13,302 system — 4 hours ago"). `/data-feed` + `/leaderboard` show per-event rows; anonymous clients render as `Mutant#XXXX`. "Live data currently under-reported while in beta."

## The tech stack (observed)

| Layer | Tool |
|---|---|
| Site | Framer |
| Analytics | PostHog EU (`phc_xVowpYzq…`), session recording + surveys on |
| Call booking | iClosed (app.iclosed.io widget) |
| Funnels | Perspective (perspective.co) |
| Live feed backend | **Convex** (convex@1.31.7 client loaded on-page) |
| Product API | **`api.onsteroids.com`** — org-scoped: `/v1/public/org_3BBFY8tI9A5gb2j6Kfuq7tJowP0/stats`; `org_…` IDs are Clerk-style |
| Platform domain | `onsteroids.com` → 301 to solaronsteroids.com (brand parked; the "solar" prefix is removable) |

No Meta pixel on the agency's own site.

## Real funnel economics (public stats API, fetched 2026-07-12)

`GET https://api.onsteroids.com/v1/public/org_…/stats`:

| Window | Leads | Quotes | Sales | Sales revenue | Quote value |
|---|---|---|---|---|---|
| All-time | 49,805 | 6,263 | 1,132 | £16,435,206 | £85,799,697 |
| Last 30d | 5,708 | 871 | 194 | £2,058,769 | £9,862,758 |
| Last 7d | 1,445 | 236 | 64 | £710,929 | £2,663,878 |
| Last day | 201 | 13 | 1 | £13,302 | £179,900 |

Derived: lead→quote ≈ 12.6%, quote→sale ≈ 18%, lead→sale ≈ 2.3%, AOV ≈ £14.5k, ~£2M/mo attributed client revenue. The site's "£102M" headline = quote value + sales revenue combined. (Homepage's smaller "£25M+ in sales" claim is presumably a different, older/verified figure.)

## Commercial model signals

- Minimum ad spend £2,500/mo (client-paid, client owns ad account — "why I'm not allowed in our clients' ad accounts" resource).
- Setup fee + monthly rolling contract, no tie-in.
- Capacity scarcity: 54/60 client cap, limited onboarding per month, location management instead of exclusivity.
- Discovery-call sales motion via iClosed (`/call/uk`, `/call/us`, `/call/uk-windows`, high-priority variants).
- ~180-article resources library answering every sales objection (pricing, ROI, contract, capacity) — objection-handling as SEO.

## What this means for a rebuild (orientation, expanded in blueprint.md)

The defensible core is not the ads or the funnels — both are commodity — it's the **closed loop**: session→lead→CRM stage→deal value→ad platform, plus the **public revenue proof** it enables. SOS prices that loop at £40–100k per bespoke install; a productized multi-tenant version with a real attribution engine (multi-model, not just first-touch stitch + last-click CAPI) and a CRM plugin system is exactly the gap.
