// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Column, Row, Section, Text } from "react-email";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Title } from "./_components/ui.js";
import type { ReceiptEmailProps } from "./types.js";

// Transactional starter — CONTENT, yours to edit. Rendered for the
// `transactional/receipt` key (see `./registry.ts`). Sent one-off from your
// billing webhook via `hs.emails.send({ template: "transactional/receipt", ... })`.
export default function ReceiptEmail({
  name = "there",
  invoiceNumber = "INV-1024",
  amount = "$49.00",
  date = "today",
  items = [{ description: "Pro plan (monthly)", amount: "$49.00" }],
  invoiceUrl,
  unsubscribeUrl,
}: ReceiptEmailProps) {
  return (
    <Layout
      preview={`Receipt ${invoiceNumber} — ${amount}`}
      eyebrow="Receipt"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Thanks for your payment</Title>
      <Body>
        Hi {name}, here's your receipt for invoice {invoiceNumber}, charged on{" "}
        {date}.
      </Body>

      <Section className="my-5 rounded-xl border border-solid border-zinc-200 px-5 py-2">
        {items.map((item, i) => (
          <Row
            // biome-ignore lint/suspicious/noArrayIndexKey: line items are static + ordered
            key={i}
            className="border-0 border-b border-solid border-zinc-100"
          >
            <Column className="py-3 text-[14px] text-zinc-700">
              {item.description}
            </Column>
            <Column className="py-3 text-right text-[14px] font-medium text-zinc-900">
              {item.amount}
            </Column>
          </Row>
        ))}
        <Row>
          <Column className="py-3 text-[14px] font-semibold text-zinc-900">
            Total
          </Column>
          <Column className="py-3 text-right text-[15px] font-bold text-zinc-900">
            {amount}
          </Column>
        </Row>
      </Section>

      {invoiceUrl && (
        <>
          <Divider />
          <Button href={invoiceUrl} variant="secondary">
            View invoice
          </Button>
        </>
      )}

      <Text className="mt-6 text-xs leading-5 text-zinc-400">
        Questions about this charge? Just reply to this email.
      </Text>
    </Layout>
  );
}
