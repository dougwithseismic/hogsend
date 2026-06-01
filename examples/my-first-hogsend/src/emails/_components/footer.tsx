// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Hr, Link, Section, Text } from "react-email";

interface FooterProps {
  unsubscribeUrl?: string;
  preferencesUrl?: string;
}

export function Footer({ unsubscribeUrl, preferencesUrl }: FooterProps) {
  return (
    <Section className="mt-8">
      <Hr className="border-gray-200" />
      <Text className="text-center text-xs text-gray-400">
        Sent by {"my-first-hogsend"}
      </Text>
      {(unsubscribeUrl || preferencesUrl) && (
        <Text className="text-center text-xs text-gray-400">
          {unsubscribeUrl && (
            <Link href={unsubscribeUrl} className="text-gray-400 underline">
              Unsubscribe
            </Link>
          )}
          {unsubscribeUrl && preferencesUrl && " | "}
          {preferencesUrl && (
            <Link href={preferencesUrl} className="text-gray-400 underline">
              Manage preferences
            </Link>
          )}
        </Text>
      )}
    </Section>
  );
}
