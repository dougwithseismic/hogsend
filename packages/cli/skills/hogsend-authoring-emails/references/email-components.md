# Building the component — shared `_components`, props, preview/category, plaintext

You write the `.tsx` with [react-email](https://react.email) primitives, but
compose the shared chrome in `src/emails/_components/` instead of hand-rolling
HTML. That keeps every email visually consistent and leaves the right slots open
for the engine to inject tracking + unsubscribe.

## The shared `_components`

| Module | Exports | Role |
|--------|---------|------|
| `_components/layout.js` | `Layout` | The shell: `<Html>` + `<Head>` + `<Preview>` + `<Tailwind>`, the wordmark, one bordered white card, then the footer. |
| `_components/ui.js` | `Eyebrow`, `Title`, `Body`, `Button`, `Callout`, `CodeBlock`, `Bullets`, `Divider` | Email-safe design-system primitives. |
| `_components/logo.js` | `Logo` | Your wordmark above the card. |
| `_components/footer.js` | `Footer` | Renders the `unsubscribeUrl` / `preferencesUrl` links (rendered by `Layout`, not directly by you). |

`Layout`'s props are the only surface most templates touch:

```ts
interface LayoutProps {
  preview: string;          // inbox snippet — required
  eyebrow?: string;         // small uppercase label above the heading
  unsubscribeUrl?: string;  // forwarded to <Footer>
  preferencesUrl?: string;  // forwarded to <Footer>
  children: ReactNode;
}
```

A minimal template composes them like this:

```tsx
// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Layout } from "./_components/layout.js";
import { Body, Bullets, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { TrialEndingEmailProps } from "./types.js";

export default function TrialEndingEmail({
  name = "there",
  daysLeft = 3,
  upgradeUrl = "https://app.example.com/billing",
  unsubscribeUrl,
}: TrialEndingEmailProps) {
  return (
    <Layout
      preview={`${daysLeft} days left on your trial`}
      eyebrow="Heads up"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Your trial ends in {daysLeft} days</Title>
      <Body>Hey {name}, here's what you keep when you upgrade:</Body>
      <Bullets items={["Unlimited journeys", "Full event history", "Priority support"]} />
      <Divider />
      <Button href={upgradeUrl}>Upgrade now</Button>
      <Callout tone="warn">Card on file is never charged automatically.</Callout>
    </Layout>
  );
}
```

These files live in YOUR repo and are yours to edit — change the colors, add
primitives, swap `Logo` for a hosted `<Img>`. Use ESM `.js` extensions on the
relative imports (consumer convention), even though the files are `.tsx`.

## Props typing

Define the props interface in `src/emails/types.ts` and import it into the
component. Two conventions:

- **Default every prop in the destructure** (`name = "there"`) so previews and
  admin catalogs render without real data, and a missing prop never produces
  `undefined` in the body.
- **Always accept an optional `unsubscribeUrl?: string`.** The engine injects it
  on send so `Layout`/`Footer` can render the unsubscribe link — see
  `tracking-and-unsubscribe.md`. Make it optional; direct render/preview calls
  won't pass it.

## Subject, preview, category — on the registry entry, not the component

These live on the `TemplateDefinition` in `src/emails/registry.ts`, NOT inside
the `.tsx`:

```ts
export interface TemplateDefinition<P = Record<string, unknown>> {
  component: (props: P) => ReactElement;
  defaultSubject: string;        // fallback subject when send() omits `subject`
  category?: string;             // e.g. "transactional" | "journey"
  preview?: (props: P) => string; // inbox snippet, computed from props
  examples?: Partial<P>;         // sample props for admin previews only
}
```

- **`defaultSubject`** is used when the send call doesn't pass an explicit
  `subject`. Journeys usually pass their own subject; transactional one-offs lean
  on the default.
- **`category`** drives frequency capping. The engine's frequency cap exempts
  `"transactional"` by default — mark genuine transactional mail (receipts,
  password resets) `"transactional"` and marketing/lifecycle mail `"journey"` so
  caps apply correctly.
- **`preview`** sets the snippet most inboxes show next to the subject. Note the
  `Layout`'s own `preview` prop renders react-email's hidden `<Preview>` text in
  the HTML; the registry `preview` is the value surfaced to admin/preview tooling
  via `getPreviewText`. Keep them consistent.

## Plaintext

You do not author a separate plaintext file. The engine renders both halves from
the same component: `renderToHtml(element)` and `renderToPlainText(element)`
(react-email's `render(element, { plainText: true })`). Write the component once;
keep links as real `<a href>` / react-email `Button`/`Link` so the plaintext
extractor produces readable URLs. See `preview-and-render.md` for the render
machinery.
