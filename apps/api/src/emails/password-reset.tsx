// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Title } from "./_components/ui.js";
import type { PasswordResetEmailProps } from "./types.js";

export default function PasswordResetEmail({
  name = "there",
  resetUrl = `${BRAND.appUrl}/reset`,
  expiresInMinutes = 60,
}: PasswordResetEmailProps) {
  return (
    <Layout
      preview={`Reset your Hogsend password — link expires in ${expiresInMinutes} minutes.`}
      eyebrow="Security"
    >
      <Title>Reset your password</Title>
      <Body>
        Hey {name} — we got a request to reset the password on your Hogsend
        account. Click below to choose a new one.
      </Body>
      <Button href={resetUrl}>Reset password</Button>
      <Body>
        This link expires in {expiresInMinutes} minutes. If you didn't request
        it, you can safely ignore this email — your password won't change.
      </Body>
    </Layout>
  );
}
