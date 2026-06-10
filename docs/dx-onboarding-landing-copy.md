# DX-onboarding landing copy — handoff to `feat/marketing-site`

The dx-onboarding train deliberately touched **no** landing files
(`apps/docs/components/landing/`, `apps/docs/app/(home)/`,
`apps/docs/components/ds/`) — that redesign is in flight on this branch.
Below are drop-in snippets for the new surfaces, with the doc pages each
should link to. Adjust freely; the claims are all verified against shipped
behaviour.

## 1. Hero / terminal block

```bash
pnpm create hogsend@latest my-app --domain mysite.com
cd my-app && hogsend dev
```

Suggested line under it:

> Two commands to a running lifecycle engine — infra, migrations, API, worker,
> and Studio, with your sending domain already wired.

Links: `/docs/getting-started`, `/docs/cli/dev`

## 2. Test-mode one-liner

> Sends are safe from the first minute: every email redirects to your own
> inbox until your domain verifies. Real journeys, real templates, real
> tracking — nothing reaches a customer before you're ready.

Links: `/docs/operating/test-mode`

## 3. Domain verification / DNS auto-apply one-liner

> `hogsend domain add` prints the DNS records formatted for your DNS host —
> and on Cloudflare or Vercel, applies them for you. `hogsend domain check`
> polls until verified; sends go live within the minute.

Links: `/docs/cli/domain`

## 4. The dev loop

> `hogsend dev` is the daily driver: one terminal, the whole stack. Fire a
> test event from a second terminal with `hogsend dev --fire signup
> --email you@example.com` and watch it move through Studio.

Links: `/docs/cli/dev`, `/docs/operating/studio`

## 5. Agents teaser

> Built to be driven by coding agents as much as by people: 14 vendored
> Claude Code skills in every scaffolded app — including playbooks that wire
> your existing product to Hogsend and migrate you off Loops or Customer.io —
> plus `/llms.txt` as the stable machine entrypoint.

Links: `/docs/agents`, `https://docs.hogsend.com/llms.txt`

## Register notes

- It's **source-available** (Elastic License 2.0), never "open source".
- No hype, no "honest"/"proof" framing, no apologies — state what it does.
- `hogsend` is the bin from `@hogsend/cli`; inside a scaffolded app it runs as
  `pnpm hogsend …` (the package is a dependency), bare after a global install.
  Hero copy can show the bare form.
