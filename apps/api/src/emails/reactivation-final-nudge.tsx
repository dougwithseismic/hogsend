// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Hr, Link, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { ReactivationFinalNudgeEmailProps } from "./types.js";

export default function ReactivationFinalNudgeEmail({
  name = "there",
  productName = "our platform",
  returnUrl = "https://app.example.com",
  unsubscribeUrl,
}: ReactivationFinalNudgeEmailProps) {
  return (
    <Layout preview="This is the last email we'll send unless you come back">
      <Heading className="text-2xl font-bold text-gray-900">
        One last note
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, this is the last email we'll send you about coming back to{" "}
        {productName}. We don't want to clutter your inbox.
      </Text>
      <Text className="text-base text-gray-600">
        Your account and data are still here if you ever want to pick things
        back up. No time limit on that.
      </Text>

      <Button
        href={returnUrl}
        className="mt-4 rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        Come Back
      </Button>

      <Hr className="my-6 border-gray-200" />

      <Text className="text-sm text-gray-400">
        If {productName} isn't for you, no hard feelings.{" "}
        {unsubscribeUrl && (
          <Link href={unsubscribeUrl} className="text-gray-400 underline">
            Unsubscribe
          </Link>
        )}
      </Text>
      <Footer />
    </Layout>
  );
}
