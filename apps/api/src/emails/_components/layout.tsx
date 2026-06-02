// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React, { type ReactNode } from "react";
import {
  Body,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Tailwind,
} from "react-email";
import { Footer } from "./footer.js";
import { Logo } from "./logo.js";
import { Eyebrow } from "./ui.js";

interface LayoutProps {
  preview: string;
  /** Optional small uppercase label above the heading. */
  eyebrow?: string;
  unsubscribeUrl?: string;
  preferencesUrl?: string;
  children: ReactNode;
}

// The shell every Hogsend email shares: a light canvas, the wordmark, one
// hairline-bordered white card, then the footer. Templates only supply the
// preview text, an optional eyebrow, and their body — the chrome is handled
// here so the set stays consistent.
export function Layout({
  preview,
  eyebrow,
  unsubscribeUrl,
  preferencesUrl,
  children,
}: LayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body className="bg-zinc-100 font-sans">
          <Container className="mx-auto w-full max-w-[600px] px-3 py-10">
            <Logo />
            <Section className="rounded-2xl border border-solid border-zinc-200 bg-white px-10 py-12">
              {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
              {children}
            </Section>
            <Footer
              unsubscribeUrl={unsubscribeUrl}
              preferencesUrl={preferencesUrl}
            />
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
