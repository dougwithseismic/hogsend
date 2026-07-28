import Link from "next/link";
import type { JSX } from "react";
import { TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Section } from "@/components/ds/section";
import { Wordmark } from "@/components/ds/wordmark";
import { LEGAL_DOCUMENTS, type LegalDocument } from "@/src/lib/legal";

/**
 * Renders a legal stub. Reading, not doing: one measured column, no actions.
 *
 * The DRAFT badge is not decoration — it is the honest label on a document a
 * lawyer has not seen, and it renders next to the title where a reader cannot
 * miss it. The `pending` list is shown for the same reason: an absent liability
 * clause is a fact about this document, and hiding it would read as a document
 * that has one.
 */
export function LegalDocumentView({
  document,
}: {
  document: LegalDocument;
}): JSX.Element {
  const other =
    document.slug === "terms" ? LEGAL_DOCUMENTS.privacy : LEGAL_DOCUMENTS.terms;

  return (
    <main className="flex flex-1 flex-col">
      {/* One centred reading column, header included — the dashboard's
          full-width PageHeader would strand the DRAFT badge 700px from the
          title it qualifies. */}
      <div className="container-page pt-8">
        <div className="mx-auto max-w-3xl">
          <Link
            href="/"
            className="inline-flex transition-opacity hover:opacity-70"
          >
            <Wordmark />
          </Link>
        </div>
      </div>

      <header className="mt-6 border-white/[0.08] border-b">
        <div className="container-page py-7">
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display font-medium text-[26px] text-white leading-[1.15] tracking-[-0.03em] md:text-[30px]">
                {document.title}
              </h1>
              <TagPill tone="caution">DRAFT</TagPill>
            </div>
            <p className="text-sm text-white/60 leading-6">
              {document.summary}
            </p>
          </div>
        </div>
      </header>

      <Section divider={false}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
          <Card className="border-caution/30 bg-caution-tint hover:border-caution/40">
            <p className="text-sm text-white/80 leading-6">
              <span className="font-medium">Draft.</span> {document.status}
            </p>
          </Card>

          <div className="flex flex-col gap-9">
            {document.sections.map((section) => (
              <section key={section.heading} className="flex flex-col gap-3">
                <h2 className="font-display text-[20px] text-white leading-[1.2] tracking-[-0.02em]">
                  {section.heading}
                </h2>
                {section.body.map((paragraph) => (
                  <p
                    key={paragraph.slice(0, 48)}
                    className="text-base text-white/60 leading-7"
                  >
                    {paragraph}
                  </p>
                ))}
              </section>
            ))}
          </div>

          <Card className="flex flex-col gap-3">
            <h2 className="font-medium text-base text-white tracking-[-0.02em]">
              Not written yet
            </h2>
            <p className="text-sm text-white/60 leading-6">
              These clauses are left to the lawyer pass rather than drafted
              here. Until they exist, this document does not cover them.
            </p>
            <ul className="flex flex-col gap-1.5">
              {document.pending.map((item) => (
                <li key={item} className="text-sm text-white/50 leading-6">
                  — {item}
                </li>
              ))}
            </ul>
          </Card>

          <p className="text-sm text-white/50">
            <Link
              href={other.path}
              className="text-white underline underline-offset-4"
            >
              {other.title}
            </Link>{" "}
            ·{" "}
            <Link
              href="/login"
              className="text-white underline underline-offset-4"
            >
              Sign in
            </Link>
          </p>
        </div>
      </Section>
    </main>
  );
}
