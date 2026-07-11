# @hogsend/sms

SMS template machinery for [Hogsend](https://github.com/dougwithseismic/hogsend)
— the SMS sibling of `@hogsend/email`. Render-only: it holds no concrete
business templates. Client apps own their `.tsx` templates + registry and
augment the open `SmsTemplateRegistryMap` interface, exactly like the email
package.

SMS templates are authored as **React components** (same DX as email) but the
engine renders them to **plain text** before the provider wire — SMS is
text-only.

## What's here

- **`SmsTemplateRegistryMap`** — an empty, augmentable interface (module
  augmentation). Declare each template key and its props in your app's
  `templates.d.ts` so `sendSms({ template, props })` is fully type-checked. This
  is a namespace SEPARATE from `@hogsend/email`'s `TemplateRegistryMap`, so SMS
  keys can never be sent through the email service and vice versa.
- **`SmsTemplateDefinition`** — `{ component, category?, preview?, examples?,
  sourcePath? }` (no `defaultSubject` — SMS has no subject line).
- **`getSmsTemplate` / `createSmsRegistry` / `withSources`** — the registry
  helpers (`withSources` stamps each definition's component source path for the
  Studio "open in editor" affordance).
- **`renderSmsToText(element)`** — renders a React SMS template to compact plain
  text (react-email's plain-text renderer + whitespace collapse).
- **`countSmsSegments(body)`** — GSM-7 vs UCS-2 segment counting (160/153 vs
  70/67), used to record the billed segment count on each send.

## Usage

```tsx
// src/sms/welcome-sms.tsx
import { Text } from "react-email";
export default function WelcomeSms({ name = "there" }) {
  return <Text>Hey {name}, welcome to Hogsend!</Text>;
}
```

```ts
// src/sms/registry.ts
import { type SmsTemplateRegistry, withSources } from "@hogsend/sms";
import WelcomeSms from "./welcome-sms.js";
export const smsTemplates: SmsTemplateRegistry = withSources(import.meta.dirname, {
  "welcome-sms": { component: WelcomeSms, category: "journey" },
});
```

```ts
// src/sms/templates.d.ts
declare module "@hogsend/sms" {
  interface SmsTemplateRegistryMap {
    "welcome-sms": { name?: string };
  }
}
```

Pass `sms: { templates: smsTemplates }` to `createHogsendClient` (in both the
API and worker entrypoints). See `docs/sms.md` for the full channel guide.
