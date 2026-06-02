// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Section, Text } from "react-email";

// Your wordmark, rendered above the email card. It's pure type + a colored
// mark so it renders crisply everywhere without a hosted asset. To use a real
// logo, swap the <Text> for:
//   <Img src="https://yourapp.com/logo.png" width="120" alt="my-first-hogsend" />
export function Logo() {
  return (
    <Section className="mb-6 px-2">
      <Text className="m-0 text-[17px] font-bold tracking-tight text-zinc-900">
        <span className="mr-1.5 text-indigo-500">&#9679;</span>
        {"my-first-hogsend"}
      </Text>
    </Section>
  );
}
