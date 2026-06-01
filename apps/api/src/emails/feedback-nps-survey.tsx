// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Heading, Link, Section, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { FeedbackNpsSurveyEmailProps } from "./types.js";

export default function FeedbackNpsSurveyEmail({
  name = "there",
  productName = "our platform",
  surveyUrl = "https://app.example.com/survey",
  unsubscribeUrl,
}: FeedbackNpsSurveyEmailProps) {
  const scores = Array.from({ length: 11 }, (_, i) => i);

  return (
    <Layout
      preview={`How likely are you to recommend ${productName}? Quick 1-click survey.`}
    >
      <Heading className="text-2xl font-bold text-gray-900">
        Quick question
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, how likely are you to recommend {productName} to a friend or
        colleague?
      </Text>

      <Section className="mt-4 text-center">
        <Text className="text-sm text-gray-500">
          Click a number below (0 = not likely, 10 = extremely likely)
        </Text>
        <Section className="mt-2">
          {scores.map((score) => (
            <Link
              key={score}
              href={`${surveyUrl}?score=${score}`}
              className="mx-1 inline-block h-9 w-9 rounded-md bg-gray-100 text-center text-sm font-semibold leading-9 text-gray-700 no-underline"
            >
              {String(score)}
            </Link>
          ))}
        </Section>
        <Section className="mt-1">
          <Text className="inline text-xs text-gray-400">
            Not likely
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            Extremely likely
          </Text>
        </Section>
      </Section>

      <Text className="mt-6 text-sm text-gray-400">
        Takes less than 10 seconds. Your feedback directly shapes what we build
        next.
      </Text>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
