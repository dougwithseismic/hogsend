# Render & preview — render helpers, the registry, how the consumer wires it

`@hogsend/email` is render machinery only. It exposes the render functions, the
registry helpers, and the open `TemplateRegistryMap` type — but no concrete
templates. Your app supplies the registry; the engine threads it through at send
and render time.

## The render helpers

```ts
import { renderToHtml, renderToPlainText } from "@hogsend/email";
import type { ReactElement } from "react";

// Both wrap react-email's render():
const html = await renderToHtml(element);        // render(element)
const text = await renderToPlainText(element);   // render(element, { plainText: true })
```

You rarely call these directly — the engine's mailer does it for you (HTML + text
from one component). They're useful for snapshot tests of a `.tsx`.

## The registry helpers

`@hogsend/email` resolves a template KEY against a `TemplateRegistry` you pass
in:

```ts
import { getTemplate, getPreviewText, createRegistry } from "@hogsend/email";

// Resolve key → { element, subject, category }
const { element, subject, category } = getTemplate({
  key: "activation/welcome",
  props: { name: "Ada", dashboardUrl: "https://app.example.com" },
  registry, // your src/emails/registry.ts `templates`
});

// Compute the inbox snippet from the entry's `preview(props)`
const snippet = getPreviewText({ key: "activation/welcome", props, registry });
```

`createRegistry(base, overrides)` shallow-merges a partial over a base registry —
handy if you ever inherit a starter set and tweak a few keys:

```ts
export const templates = createRegistry(starterTemplates, {
  "activation/welcome": { ...starterTemplates["activation/welcome"], category: "journey" },
});
```

## How the consumer registry is built and threaded

You build the registry once in `src/emails/registry.ts` and re-export it from
`src/emails/index.ts`:

```ts
// src/emails/registry.ts
import type { TemplateRegistry } from "@hogsend/email";
import WelcomeEmail from "./welcome.js";
import ActivationNudgeEmail from "./activation-nudge.js";

export const templates: TemplateRegistry = {
  "activation/welcome": {
    component: WelcomeEmail,
    defaultSubject: "Welcome aboard",
    category: "transactional",
    preview: (props) => `Welcome, ${props.name}!`,
  },
  "activation/nudge": {
    component: ActivationNudgeEmail,
    defaultSubject: "You haven't tried the key feature yet",
    category: "journey",
    preview: (props) => `${props.name}, you're missing out`,
  },
};
```

```ts
// src/emails/index.ts
export { templates } from "./registry.js";
export type { ActivationNudgeEmailProps, WelcomeEmailProps } from "./types.js";
```

The wiring into the engine already exists in `src/index.ts` — you don't add it,
but this is what it looks like:

```ts
// src/index.ts (already present in the scaffold)
import { createHogsendClient } from "@hogsend/engine";
import { templates } from "./emails/index.js";

const client = createHogsendClient({ journeys, buckets, email: { templates } });
```

`createHogsendClient` stores your `templates` on the email-service config; the
engine's `createTrackedMailer` reads `config.templates` and passes it to
`getTemplate({ key, props, registry })` on every `send` and `render`. That is the
whole reason the engine never bakes in business templates — yours flow in here.

## Previewing a template

For an at-a-glance HTML preview during development, render a component to a file:

```ts
// scripts/preview.ts (your repo, run with tsx)
import { renderToHtml } from "@hogsend/email";
import { writeFileSync } from "node:fs";
import { templates } from "../src/emails/index.js";

const { component } = templates["activation/welcome"];
const html = await renderToHtml(component({ name: "Ada" }));
writeFileSync("preview.html", html);
```

Or run react-email's own dev server if you keep one configured. To inspect real
sends (open/click/bounce rates per template) against a running instance, use the
**hogsend-cli** skill rather than rendering locally.
