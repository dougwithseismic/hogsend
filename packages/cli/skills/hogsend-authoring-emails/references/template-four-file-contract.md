# The template contract — five touch points that must agree

A sendable, type-checked template is one string (`"activation/welcome"`) wired
across five files. Get any of them out of sync and you get a compile error at
the `send` call site — this is the single most common email-authoring bug. The
checklist:

| # | File | What it declares | Keyed on |
|---|------|------------------|----------|
| 1 | `src/emails/<name>.tsx` | the react-email component (default export) | imported by (3) |
| 2 | `src/emails/types.ts` | the `Props` interface | imported by (1) + (4) |
| 3 | `src/emails/registry.ts` | `templates[key]` → component + subject + category | **the key** |
| 4 | `src/emails/templates.d.ts` | augments `TemplateRegistryMap` so `key → Props` | **the key** + Props |
| 5 | `src/journeys/constants/index.ts` | `Templates.*` constant journeys send | **the key** |

The **key** in (3), (4), and (5) must be byte-identical. The **Props** in (2)
must match what (1) destructures and what (4) maps the key to.

## Walk through, file by file

### 1. The component — `src/emails/order-shipped.tsx`

```tsx
// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Layout } from "./_components/layout.js";
import { Body, Button, Title } from "./_components/ui.js";
import type { OrderShippedEmailProps } from "./types.js";

export default function OrderShippedEmail({
  name = "there",
  trackingUrl = "https://example.com/track",
  unsubscribeUrl,
}: OrderShippedEmailProps) {
  return (
    <Layout
      preview={`Your order is on its way, ${name}`}
      eyebrow="Shipped"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Your order is on its way</Title>
      <Body>Hey {name}, we just handed it to the carrier.</Body>
      <Button href={trackingUrl}>Track your package</Button>
    </Layout>
  );
}
```

### 2. The props — `src/emails/types.ts`

```ts
export interface OrderShippedEmailProps {
  name: string;
  trackingUrl?: string;
  // Engine-injected on send (see tracking-and-unsubscribe.md) — accept it so
  // the Layout/Footer can render an unsubscribe link. Always optional.
  unsubscribeUrl?: string;
}
```

### 3. The registry entry — `src/emails/registry.ts`

```ts
import type { TemplateRegistry } from "@hogsend/email";
import OrderShippedEmail from "./order-shipped.js";
// ...other imports

export const templates: TemplateRegistry = {
  // ...other entries
  "fulfilment/order-shipped": {
    component: OrderShippedEmail,
    defaultSubject: "Your order is on its way",
    category: "transactional",
    preview: (props) => `On its way, ${props.name}`,
  },
};
```

### 4. The augmentation — `src/emails/templates.d.ts`

```ts
import type { OrderShippedEmailProps } from "./types.js";

declare module "@hogsend/email" {
  interface TemplateRegistryMap {
    // ...other keys
    "fulfilment/order-shipped": OrderShippedEmailProps;
  }
}
```

`@hogsend/email` ships an **empty** `TemplateRegistryMap`. This `declare module`
block is the only thing that teaches the type system your keys → props, which is
what makes `emailService.send({ template, props })` type-check.

### 5. The constant — `src/journeys/constants/index.ts`

```ts
export const Templates = {
  // ...existing keys
  ORDER_SHIPPED: "fulfilment/order-shipped",
} as const;
```

Journeys send `template: Templates.ORDER_SHIPPED`, never a raw string, so a typo
is a compile error rather than a silently-missing template at runtime.

## The #1 type-error trap

The send site resolves props from the registry map:

```ts
// engine signature (do not edit): send<K extends TemplateName>(
//   options: { template: K; props: TemplateRegistryMap[K]; ... })
await container.emailService.send({
  template: "fulfilment/order-shipped",
  props: { name: "Ada", trackingUrl: "https://…" }, // typed by templates.d.ts
  to: user.email,
});
```

If you added the registry entry (3) but forgot the augmentation (4), `TemplateName`
won't include your key and `template:` rejects the string. If (2) and (4)
disagree on Props, `props:` rejects the object. **When you see "is not assignable
to TemplateName" or a props mismatch, re-check 2/3/4/5 against each other.**

## Rename / delete checklist

Renaming `"a/old"` → `"a/new"`: change the literal in (3), (4), and (5) together;
no `.tsx`/`types.ts` change needed if the component/props are unchanged. Deleting
a template: remove its entry from (3), its line from (4), its `Templates.*`
constant from (5) if present, then delete the `.tsx` and its `Props` from (2).
Leaving a key in (4) with no (3) entry, or vice-versa, will surface as a type or
runtime error.
