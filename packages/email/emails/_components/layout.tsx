import type { ReactNode } from "react";
import {
  Body,
  Container,
  Head,
  Html,
  Preview,
  Section,
  Tailwind,
} from "react-email";

interface LayoutProps {
  preview: string;
  children: ReactNode;
}

export function Layout({ preview, children }: LayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body className="bg-gray-50 font-sans">
          <Container className="mx-auto max-w-[600px] py-8">
            <Section className="rounded-lg bg-white px-8 py-10 shadow-sm">
              {children}
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
