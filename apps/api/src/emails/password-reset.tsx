// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { PasswordResetEmailProps } from "./types.js";

export default function PasswordResetEmail({
  name = "there",
  resetUrl = "https://app.hogsend.com/reset",
  expiresInMinutes = 60,
}: PasswordResetEmailProps) {
  return (
    <Layout
      preview={`Reset your Hogsend password — this link expires in ${expiresInMinutes} minutes.`}
    >
      <Heading className="text-2xl font-bold text-gray-900">
        Reset your password
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, we received a request to reset your password. Click the
        button below to choose a new one.
      </Text>
      <Button
        href={resetUrl}
        className="rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        Reset Password
      </Button>
      <Text className="mt-4 text-sm text-gray-400">
        This link expires in {expiresInMinutes} minutes. If you didn't request
        this, you can safely ignore this email.
      </Text>
      <Footer />
    </Layout>
  );
}
