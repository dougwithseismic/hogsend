// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Link } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Title } from "./_components/ui.js";
import type { WinbackFinalNoteEmailProps } from "./types.js";

// The last email of the winback sequence — and it says so. If they don't
// click, the journey stops mailing them. Honesty is the tactic.
export default function WinbackFinalNoteEmail({
  name = "there",
  returnUrl = `${BRAND.appUrl}`,
  unsubscribeUrl,
}: WinbackFinalNoteEmailProps) {
  return (
    <Layout
      preview="Last one from us — promise"
      eyebrow="Final note"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>We'll stop here</Title>
      <Body>
        Hey {name} — this is the last email in this sequence. If you don't open
        the app after this one, we take the hint and stop sending. No "we miss
        you" every quarter forever.
      </Body>
      <Body>
        If there's still something here for you, the door's open and your
        workspace is intact.
      </Body>
      <Button href={returnUrl}>Open my workspace</Button>
      <Body>
        {unsubscribeUrl ? (
          <>
            Or skip the wait and{" "}
            <Link href={unsubscribeUrl} className="text-zinc-600 underline">
              unsubscribe now
            </Link>{" "}
            — genuinely fine either way.
          </>
        ) : (
          "Either way — thanks for trying it."
        )}
      </Body>
    </Layout>
  );
}
