import { Hr, Link, Section, Text } from "react-email";

interface FooterProps {
  unsubscribeUrl?: string;
}

export function Footer({ unsubscribeUrl }: FooterProps) {
  return (
    <Section className="mt-8">
      <Hr className="border-gray-200" />
      <Text className="text-center text-xs text-gray-400">Sent by Hogsend</Text>
      {unsubscribeUrl && (
        <Text className="text-center text-xs text-gray-400">
          <Link href={unsubscribeUrl} className="text-gray-400 underline">
            Unsubscribe
          </Link>
        </Text>
      )}
    </Section>
  );
}
