// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Link } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Title } from "./_components/ui.js";
import type { ReactivationFinalNudgeEmailProps } from "./types.js";

export default function ReactivationFinalNudgeEmail({
  name = "there",
  returnUrl = BRAND.appUrl,
  unsubscribeUrl,
}: ReactivationFinalNudgeEmailProps) {
  return (
    <Layout
      preview="The last email we'll send unless you come back"
      eyebrow="One last note"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>We'll leave it here</Title>
      <Body>
        Hey {name} — this is the last reactivation email we'll send. We'd rather
        respect your inbox than keep nudging. (Fittingly, this whole sequence is
        a Hogsend journey that exits itself right here.)
      </Body>
      <Body>
        Your account, journeys, and data stay put with no time limit — so if you
        ever want to pick things back up, everything's waiting.
      </Body>
      <Button href={returnUrl}>Come back to Hogsend</Button>

      <Divider />
      <Body>
        Not the right fit? No hard feelings — you can{" "}
        {unsubscribeUrl ? (
          <Link
            href={unsubscribeUrl}
            className="font-semibold text-zinc-900 underline"
          >
            unsubscribe here
          </Link>
        ) : (
          "unsubscribe anytime"
        )}
        .
      </Body>
    </Layout>
  );
}
