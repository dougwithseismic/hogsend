// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { TransactionalMagicLinkProps } from "./types.js";

export default function TransactionalMagicLink({
  name = "there",
  magicLinkUrl = `${BRAND.appUrl}/auth/magic`,
  expiresIn = "15 minutes",
}: TransactionalMagicLinkProps) {
  return (
    <Layout
      preview="Your secure sign-in link is ready — no password needed."
      eyebrow="Sign in"
    >
      <Title>Your sign-in link</Title>
      <Body>
        Hey {name} — here's your one-tap link to sign in to {BRAND.name}. No
        password required.
      </Body>
      <Divider />
      <Button href={magicLinkUrl}>Sign in to {BRAND.name}</Button>
      <Callout tone="default">
        <Text className="m-0 text-sm leading-6 text-zinc-700">
          This link expires in {expiresIn} and can only be used once. Request a
          fresh one any time from the sign-in screen.
        </Text>
      </Callout>
      <Body>
        If you didn't try to sign in, you can ignore this email — the link is
        useless without access to your inbox.
      </Body>
    </Layout>
  );
}
