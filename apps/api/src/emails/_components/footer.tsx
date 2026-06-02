// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Link, Section, Text } from "react-email";
import { BRAND } from "./brand.js";

interface FooterProps {
  unsubscribeUrl?: string;
  preferencesUrl?: string;
}

export function Footer({ unsubscribeUrl, preferencesUrl }: FooterProps) {
  return (
    <Section className="px-2 py-6">
      <Text className="m-0 text-xs leading-5 text-zinc-400">
        {BRAND.name} — {BRAND.tagline}
      </Text>
      <Text className="m-0 mt-1 text-xs leading-5 text-zinc-400">
        <Link href={BRAND.docsUrl} className="text-zinc-500 underline">
          Docs
        </Link>
        {" · "}
        <Link href={BRAND.communityUrl} className="text-zinc-500 underline">
          Community
        </Link>
        {(unsubscribeUrl || preferencesUrl) && " · "}
        {unsubscribeUrl && (
          <Link href={unsubscribeUrl} className="text-zinc-500 underline">
            Unsubscribe
          </Link>
        )}
        {unsubscribeUrl && preferencesUrl && " · "}
        {preferencesUrl && (
          <Link href={preferencesUrl} className="text-zinc-500 underline">
            Email preferences
          </Link>
        )}
      </Text>
    </Section>
  );
}
