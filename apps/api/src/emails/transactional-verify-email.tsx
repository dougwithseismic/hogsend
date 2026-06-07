// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { TransactionalVerifyEmailProps } from "./types.js";

export default function TransactionalVerifyEmail({
  name = "there",
  verifyUrl = `${BRAND.appUrl}/verify`,
  expiresIn = "24 hours",
}: TransactionalVerifyEmailProps) {
  return (
    <Layout
      preview="Confirm your email address to finish setting up your account."
      eyebrow="Verify your email"
    >
      <Title>Confirm your email address</Title>
      <Body>
        Hey {name} — thanks for signing up for {BRAND.name}. Confirm this is
        your email address and we'll finish setting up your account.
      </Body>
      <Divider />
      <Button href={verifyUrl}>Verify email address</Button>
      <Callout tone="default">
        <Text className="m-0 text-sm leading-6 text-zinc-700">
          This link expires in {expiresIn}. If it lapses, just request a new one
          from the sign-in screen.
        </Text>
      </Callout>
      <Body>
        Didn't create a {BRAND.name} account? You can safely ignore this email —
        nothing will happen until the address is verified.
      </Body>
    </Layout>
  );
}
