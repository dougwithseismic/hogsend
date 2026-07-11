// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import type { WinbackSmsProps } from "./types.js";

export default function WinbackSms({
  name = "there",
  discountPercent = 25,
  offerUrl = "https://hogsend.com/comeback",
}: WinbackSmsProps) {
  return (
    <Text>
      {name}, we miss you! Here's {discountPercent}% off to pick up where you
      left off: {offerUrl}
    </Text>
  );
}
