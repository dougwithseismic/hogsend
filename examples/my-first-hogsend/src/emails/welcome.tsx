// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { WelcomeEmailProps } from "./types.js";

// Starter template — CONTENT, yours to edit. Rendered for the `activation/welcome`
// key (see `./registry.ts`). Delete or rewrite freely.
export default function WelcomeEmail({
  name = "there",
  dashboardUrl = "https://app.example.com",
  unsubscribeUrl,
}: WelcomeEmailProps) {
  return (
    <Layout preview={`Welcome to my-first-hogsend, ${name}!`}>
      <Heading className="text-2xl font-bold text-gray-900">
        Welcome to {"my-first-hogsend"}
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, thanks for signing up. Let's get you up and running.
      </Text>
      <Button
        href={dashboardUrl}
        className="rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        Go to Dashboard
      </Button>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
