// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Link } from "react-email";
import { Layout } from "./_components/layout.js";
import { Body, Title } from "./_components/ui.js";
import type { RetentionFounderCheckinEmailProps } from "./types.js";

// Usage-drop early warning. Deliberately plain — no buttons, no imagery.
// It should read like a person noticed, because one did (the journey just
// did the noticing first).
export default function RetentionFounderCheckinEmail({
  name = "there",
  founderName = "Doug",
  founderEmail = "doug@example.com",
  usageObservation = "your sends dropped off about two weeks ago",
  unsubscribeUrl,
}: RetentionFounderCheckinEmailProps) {
  return (
    <Layout
      preview="Noticed something — is everything working for you?"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Quick check-in</Title>
      <Body>
        Hey {name} — {founderName} here. I noticed {usageObservation}. Sometimes
        that's just a quiet stretch; sometimes it means something broke or got
        confusing, and nobody told us.
      </Body>
      <Body>
        If it's the second one, I'd genuinely like to know — reply to this email
        and it comes straight to me, not a queue. Even "we stopped using it
        because X" is useful.
      </Body>
      <Body>And if everything's fine — ignore this entirely.</Body>
      <Body>
        — {founderName} ·{" "}
        <Link
          href={`mailto:${founderEmail}`}
          className="text-zinc-600 underline"
        >
          {founderEmail}
        </Link>
      </Body>
    </Layout>
  );
}
