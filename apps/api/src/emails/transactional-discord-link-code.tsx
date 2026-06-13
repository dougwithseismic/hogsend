// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Callout, Divider, Title } from "./_components/ui.js";
import type { TransactionalDiscordLinkCodeProps } from "./types.js";

export default function TransactionalDiscordLinkCode({
  name = "there",
  code = "428917",
}: TransactionalDiscordLinkCodeProps) {
  return (
    <Layout
      preview="Your Discord verification code — paste it into /verify."
      eyebrow="Link your Discord account"
    >
      <Title>Your Discord verification code</Title>
      <Body>
        Hey {name} — you asked to link this email to your Discord account on{" "}
        {BRAND.name}. Run <strong>/verify {code}</strong> back in Discord to
        finish.
      </Body>
      <Divider />
      <Callout tone="default">
        <Text className="m-0 text-center text-3xl font-bold tracking-[0.3em] text-zinc-900">
          {code}
        </Text>
      </Callout>
      <Body>
        This code expires in 15 minutes and can only be used once. If you didn't
        request it, you can safely ignore this email — nothing happens until the
        code is verified inside Discord.
      </Body>
    </Layout>
  );
}
