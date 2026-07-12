# Solar on Steroids — deep research (2026-07-12)

How solaronsteroids.com operates, researched to rebuild the business model from scratch: Meta ads → quiz-funnel lead gen → CRM delivery via plugin system → revenue tracking + multi-model attribution from day one.

- **[blueprint.md](./blueprint.md)** — the synthesis: how SOS works, the market gap, full build architecture (identity edge, ledger, CRMProvider, conversion-point definitions, attribution engine, CAPI feedback, proof feed), Hogsend mapping, business-model options, verification flags. **Start here.**
- **[recon.md](./recon.md)** — primary in-browser evidence: the five-part machine, the attribution-system trace, tech stack (Framer/PostHog/Perspective/Convex/`api.onsteroids.com`), real funnel economics from their public stats API.
- **findings/** — six Opus 4.8 research reports + completeness critic:
  - [business-model.md](./findings/business-model.md) — fees (retainer > ad spend), capacity/scarcity, origin story, team, moat analysis
  - [attribution-system.md](./findings/attribution-system.md) — reverse-engineered loop + Meta CAPI mechanics (fbc, EMQ, dedup, Conversion Leads) + where multi-model slots in
  - [funnel-layer.md](./findings/funnel-layer.md) — Perspective vs Heyflow vs build; question architecture doctrine; attribution-capture spec
  - [crm-plugin-layer.md](./findings/crm-plugin-layer.md) — 7-CRM comparison, CRMProvider contract, failure modes
  - [meta-ads-engine.md](./findings/meta-ads-engine.md) — creative taxonomy, volume/fatigue cadence, account discipline, CAPI feedback effects
  - [market-productization.md](./findings/market-productization.md) — competitor map (Hyros/Triple Whale/Cometly/…), the whitespace, pricing benchmarks
  - [critic.md](./findings/critic.md) — gaps, contradictions, suspect claims, ranked next questions

Headline finding: SOS's moat is the closed loop (session UID → CRM stage → deal value → valued Meta CAPI event) + a public revenue-proof feed; they license it for £40–100k and have parked `onsteroids.com` as a platform brand. They do NOT have a multi-model attribution engine — that, plus a generic multi-CRM plugin layer and per-campaign conversion-point definitions, is the build.
