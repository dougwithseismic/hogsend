import type { Metadata } from "next";
import { LegalDocumentView } from "@/components/cloud/legal-document";
import { LEGAL_DOCUMENTS } from "@/src/lib/legal";

const DOCUMENT = LEGAL_DOCUMENTS.privacy;

export const metadata: Metadata = {
  title: `${DOCUMENT.title} (draft)`,
  description: DOCUMENT.summary,
};

export default function PrivacyPage() {
  return <LegalDocumentView document={DOCUMENT} />;
}
