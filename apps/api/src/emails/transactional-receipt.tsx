// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Column, Row, Section } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Title } from "./_components/ui.js";
import type { TransactionalReceiptProps } from "./types.js";

const DEFAULT_ITEMS = [
  { description: "Hogsend Cloud — Team plan", amount: "$49.00" },
  { description: "Additional seats (2)", amount: "$20.00" },
];

export default function TransactionalReceipt({
  name = "there",
  orderId = "HS-10428",
  items = DEFAULT_ITEMS,
  total = "$69.00",
  receiptUrl = `${BRAND.appUrl}/billing`,
  purchasedAt = "June 7, 2026",
}: TransactionalReceiptProps) {
  return (
    <Layout
      preview={`Receipt for order ${orderId} — ${total}.`}
      eyebrow="Receipt"
    >
      <Title>Thanks for your purchase</Title>
      <Body>
        Hey {name} — here's the receipt for order{" "}
        <span className="font-mono text-zinc-900">{orderId}</span>, placed on{" "}
        {purchasedAt}.
      </Body>

      <Section className="my-5 rounded-xl border border-solid border-zinc-200 bg-zinc-50 px-5 py-3">
        {items.map((item, i) => (
          <Row
            // biome-ignore lint/suspicious/noArrayIndexKey: line items are static + ordered
            key={i}
            className="border-0 border-b border-solid border-zinc-200"
          >
            <Column className="py-2 text-[14px] leading-6 text-zinc-700">
              {item.description}
            </Column>
            <Column className="py-2 text-right text-[14px] font-medium leading-6 text-zinc-900">
              {item.amount}
            </Column>
          </Row>
        ))}
        <Row>
          <Column className="py-3 text-[14px] font-semibold leading-6 text-zinc-900">
            Total
          </Column>
          <Column className="py-3 text-right text-[15px] font-bold leading-6 text-zinc-900">
            {total}
          </Column>
        </Row>
      </Section>

      <Divider />
      <Button href={receiptUrl}>View full receipt</Button>
      <Body>
        Questions about this charge? Reply to this email or reach us at{" "}
        <a
          href={`mailto:${BRAND.supportEmail}`}
          className="font-semibold text-zinc-900 underline"
        >
          {BRAND.supportEmail}
        </a>
        .
      </Body>
    </Layout>
  );
}
