---
"@hogsend/studio": minor
---

Restyle Studio in the crimzon design system so it reads as an extension of the docs site: ink `#050101` page, red `#F64838` accent, white hairline borders, Inter Display headings with Inter body (vendored woff2 + fontsource), eyebrow micro-labels on table headers and section titles, glass-panel dialogs/toasts, in-palette status chips (white tiers for healthy states, red-on-tint for failures), and the docs brand lockup in the sidebar. Migrates the package from Tailwind v3 to v4 (`@tailwindcss/vite`, `@theme` tokens replacing `tailwind.config.js`/PostCSS). Visual-only — no component APIs, routes, or behavior changed.
