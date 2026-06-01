# @hogsend/email

Email **machinery** for Hogsend, built on [React Email](https://react.email):
template rendering, a typed template registry, and unsubscribe token/URL helpers.

> **No concrete business templates live here.** As of the boundary revision,
> your `.tsx` templates are content you own in your app's `src/emails/`. And
> **sending isn't here either** — that moved to the engine. This package is just
> the typed plumbing both of those build on.

## Where the rest went

| You want to… | Use | Lives in |
| --- | --- | --- |
| Render a template to HTML/text | `renderToHtml` / `renderToPlainText` | `@hogsend/email` (here) |
| Resolve a template by key | `getTemplate(..., { registry })` | `@hogsend/email` (here) |
| Build / merge a template registry | `createRegistry` | `@hogsend/email` (here) |
| Generate unsubscribe links/tokens | `generateUnsubscribeUrl`, `generateUnsubscribeToken`, … | `@hogsend/email` (here) |
| **Send** a tracked email | `createTrackedMailer` / `sendEmail()` | `@hogsend/engine` |
| Talk to the email provider | `createResendProvider` (the `EmailProvider` contract) | `@hogsend/plugin-resend` |
| **Own** your email designs | `welcome.tsx`, `registry.ts`, `templates.d.ts` | **your app** `src/emails/` |

Link rewriting, the open pixel, preference/suppression checks, the `email_sends`
write, and webhook status updates all live in the engine's `createTrackedMailer`,
so they come along regardless of which `EmailProvider` you supply.

## Public API

```ts
import {
  // rendering
  renderToHtml,
  renderToPlainText,
  // registry
  createRegistry,
  getTemplate,
  getTemplateDefinition,
  getPreviewText,
  getTemplateNames,
  // unsubscribe
  generateUnsubscribeUrl,
  generatePreferenceCenterUrl,
  generateUnsubscribeToken,
  validateUnsubscribeToken,
  // errors
  EmailSendError,
  EmailSuppressionError,
  WebhookVerificationError,
  InvalidTokenError,
} from "@hogsend/email";

import type {
  TemplateRegistry,
  TemplateRegistryMap,
  TemplateDefinition,
  TemplateName,
} from "@hogsend/email";
```

## Owning your templates (Option B — module augmentation)

Templates are your content. Put the `.tsx` files in your app's `src/emails/`,
build a registry, and augment `TemplateRegistryMap` so the engine's `sendEmail`
is fully type-checked against *your* templates.

**`src/emails/welcome.tsx`** — a normal React Email component you design freely.

**`src/emails/registry.ts`** — map each key to its component, subject, category:

```ts
import { createRegistry } from "@hogsend/email";
import { WelcomeEmail } from "./welcome.js";

export const templates = createRegistry({
  welcome: {
    component: WelcomeEmail,
    defaultSubject: "Welcome to Acme",
    category: "transactional",
    preview: (props) => `Welcome, ${props.name}!`,
  },
});
```

**`src/emails/templates.d.ts`** — the augmentation that gives you type safety:

```ts
import type { WelcomeEmailProps } from "./welcome.js";

declare module "@hogsend/email" {
  interface TemplateRegistryMap {
    welcome: WelcomeEmailProps;
    // add a line per template; key ↔ props are enforced everywhere
  }
}
```

Pass the registry to the client: `createHogsendClient({ journeys, email: { templates } })`.
Now `sendEmail({ template: "welcome", props: { name: "Doug" } })` is checked —
an unknown key or wrong props is a compile error.

> `create-hogsend` scaffolds a starter `src/emails/` (a couple of templates +
> `registry.ts` + `templates.d.ts`) so this is wired from the first commit.

## Rendering directly

```ts
import { getTemplate, renderToHtml } from "@hogsend/email";

const { element, subject, category } = getTemplate({
  key: "welcome",
  props: { name: "Jane" },
  registry, // your TemplateRegistry
});
const html = await renderToHtml(element);
```

## Scripts

```bash
pnpm build         # tsup build to dist/
pnpm test          # vitest run
pnpm check-types   # tsc --noEmit
```

Preview your designs from your **app** (where the `.tsx` files live) with the
React Email dev server, not from this package.

## Peer dependencies

`react` / `react-dom` (peer). This package no longer depends on `@hogsend/db`
or a mail provider — it's pure rendering + typing machinery.
