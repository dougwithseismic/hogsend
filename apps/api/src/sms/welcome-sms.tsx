// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import type { WelcomeSmsProps } from "./types.js";

/**
 * SMS templates are authored as React components (same DX as email) but the
 * engine renders them to PLAIN TEXT via `@hogsend/sms` `renderSmsToText` before
 * the provider wire. Keep bodies short — SMS is billed per 160-char segment.
 */
export default function WelcomeSms({
  name = "there",
  quickstartUrl = "https://hogsend.com/quickstart",
}: WelcomeSmsProps) {
  return (
    <Text>
      Hey {name}, welcome to Hogsend! Get your first journey live in ~5 min:{" "}
      {quickstartUrl}
    </Text>
  );
}
