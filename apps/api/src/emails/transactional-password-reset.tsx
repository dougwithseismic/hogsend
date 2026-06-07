// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { TransactionalPasswordResetProps } from "./types.js";

export default function TransactionalPasswordReset({
  name = "there",
  resetUrl = `${BRAND.appUrl}/reset-password`,
  expiresIn = "1 hour",
}: TransactionalPasswordResetProps) {
  return (
    <Layout
      preview="Reset your password using the secure link inside."
      eyebrow="Password reset"
    >
      <Title>Reset your password</Title>
      <Body>
        Hey {name} — we got a request to reset the password on your {BRAND.name}{" "}
        account. Click below to choose a new one.
      </Body>
      <Divider />
      <Button href={resetUrl}>Choose a new password</Button>
      <Callout tone="warn">
        <Text className="m-0 text-sm leading-6 text-amber-900">
          This link expires in {expiresIn}. If you didn't ask to reset your
          password, ignore this email — your current password stays active.
        </Text>
      </Callout>
      <Body>
        For your security, this link only works once and only from this email.
        If you run into trouble, reply and a real person will help.
      </Body>
    </Layout>
  );
}
