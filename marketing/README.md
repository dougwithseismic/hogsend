# Marketing assets

Screenshots and collateral for Hogsend and Hogsend Studio. All captures are
retina (2× device scale) PNGs at a 1600×1000 viewport, shot with
`shoot.mjs` (Playwright).

## Studio (`screenshots/studio/`)

Studio 0.17.0 in the crimzon design system, served by the engine mount at
`/studio` against a local dev database.

| File | What it shows |
| --- | --- |
| `00-login.png` | Logged-out auth gate — brand lockup, STUDIO eyebrow, glass card |
| `01-overview.png` | Overview dashboard — stat cards, delivery/engagement metrics |
| `02-sends.png` | Sends — filter panel, status chips (Sent / Failed) |
| `03-templates.png` | Templates — master-detail catalog with live email preview |
| `04-journeys.png` | Journeys — full lifecycle catalog with per-journey funnels |
| `05-buckets.png` | Buckets |
| `06-contacts.png` | Contacts — searchable table, mono external IDs |
| `07-suppressions.png` | Suppressions |
| `08-setup.png` | Setup — domain verification, DNS records |
| `09-settings.png` | Settings — API keys |
| `10-debug.png` | Debug — event injection console |
| `11-send-drawer.png` | Send detail drawer — timeline + tracked links |
| `12-contact-drawer.png` | Contact detail drawer — activity timeline |

## Site (`screenshots/site/`)

Live hogsend.com.

| File | What it shows |
| --- | --- |
| `00-hero.png` | Landing hero (above the fold) |
| `01-landing-full.png` | Entire landing page, full height |
| `02-docs.png` | Docs UI |

## Regenerating

```bash
# from a dir with playwright installed (npm i playwright):
# 1. run the API locally (engine serves Studio at :3002/studio)
pnpm --filter @hogsend/api dev
# 2. shoot — pass a Studio admin's credentials
STUDIO_EMAIL=you@example.com STUDIO_PASSWORD=... node marketing/shoot.mjs
```
