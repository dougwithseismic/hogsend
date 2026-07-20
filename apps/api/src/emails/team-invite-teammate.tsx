// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Bullets, Button, Divider, Title } from "./_components/ui.js";
import type { TeamInviteTeammateEmailProps } from "./types.js";

export default function TeamInviteTeammateEmail({
  name = "there",
  seatsAvailable,
  inviteUrl = `${BRAND.appUrl}/settings/team`,
  unsubscribeUrl,
}: TeamInviteTeammateEmailProps) {
  return (
    <Layout
      preview="Journeys ship faster when someone else can review them"
      eyebrow="Your team"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Working alone in here?</Title>
      <Body>
        Hey {name} — your journeys live in your repo, which means they can go
        through the same review your code does. That only works if a teammate
        has a seat. With your team in the workspace:
      </Body>
      <Bullets
        items={[
          "Journey changes ship as pull requests someone actually reviews",
          "Studio's flow map and send history are visible to whoever's on call",
          "Broadcasts get a second pair of eyes before they go to a list",
        ]}
      />
      <Divider />
      <Body>
        {seatsAvailable
          ? `You have ${seatsAvailable} open seat${seatsAvailable === 1 ? "" : "s"} on your plan — inviting someone takes about a minute.`
          : "Inviting someone takes about a minute."}
      </Body>
      <Button href={inviteUrl}>Invite a teammate</Button>
    </Layout>
  );
}
