---
"@hogsend/engine": patch
"@hogsend/db": patch
"@hogsend/core": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/email": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

create-hogsend: finish the onboarding hand-off — Studio, Discord, and docs, not just Hatchet.

Once a scaffold (and `bootstrap`) finishes, the "what now" now leads with the three
touchpoints that matter — the Studio dashboard (`http://localhost:3002/studio`), the
Discord invite (`discord.gg/rv6eZNvYrr`), and the docs — instead of dropping the user
at the Hatchet dashboard. The bootstrap summary also states plainly that local infra
is up but the app itself is NOT running yet: the compose stack is only Postgres + Redis
+ Hatchet, while the API and worker are your code, started with `dev` + `worker:dev`.
A closing "Welcome to Hogsend" bookends the scaffolder's opening note.

Two fixes ride along:

- The CLI's git-init and dependency-install now run as async `spawn` instead of the
  blocking `spawnSync`. A clack spinner animates on a `setInterval`, and `spawnSync`
  froze the event loop for the whole (often 30s+) install — so the spinner sat dead on
  one frame and read as "is this stuck?". `spawn` keeps the loop free so it actually
  spins.
- The engine dev banner pointed Studio at a Vite `:5173` origin that only exists in
  the monorepo, so a scaffolded `pnpm dev` showed a link that 404'd. It now points at
  the API's own `${url}/studio`, where the Studio SPA is actually served, and adds the
  Discord link.

The rest of the `@hogsend/*` line moves with this patch to stay on a single engine
version line.
