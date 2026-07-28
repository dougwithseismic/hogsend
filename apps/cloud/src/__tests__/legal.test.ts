import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "../../app/privacy/page";
import TermsPage from "../../app/terms/page";
import { guardRoute, PUBLIC_ROUTES } from "../lib/auth-guard";
import { LEGAL_DOCUMENTS, LEGAL_PATHS } from "../lib/legal";

/**
 * The legal stubs. Two things are worth a test here: that a visitor with no
 * account can actually read them (they are linked from the sign-in screen), and
 * that the DRAFT label is on the page — an unbadged stub reads as a contract.
 */

const DOCUMENTS = Object.values(LEGAL_DOCUMENTS);

describe("legal routes are public", () => {
  it.each([...LEGAL_PATHS])("allows %s with no session", (path) => {
    expect(guardRoute({ pathname: path, hasSession: false })).toEqual({
      action: "allow",
    });
  });

  it.each([...LEGAL_PATHS])("allows %s with a session too", (path) => {
    // A public page answers the same to everyone: a signed-in reader must not
    // be bounced off the terms they opened.
    expect(guardRoute({ pathname: path, hasSession: true })).toEqual({
      action: "allow",
    });
  });

  it("lists exactly the legal paths as public", () => {
    expect([...PUBLIC_ROUTES]).toEqual([...LEGAL_PATHS]);
  });
});

describe("legal documents", () => {
  it.each(DOCUMENTS)("$path has substantive, factual sections", (document) => {
    expect(document.sections.length).toBeGreaterThan(3);
    for (const section of document.sections) {
      expect(section.heading.length).toBeGreaterThan(0);
      expect(section.body.length).toBeGreaterThan(0);
      for (const paragraph of section.body) {
        expect(paragraph.length).toBeGreaterThan(40);
      }
    }
  });

  it.each(DOCUMENTS)("$path names what a lawyer still owes", (document) => {
    // The pending list is the honest half of a stub: it says which clauses do
    // NOT exist, so the absence cannot be mistaken for coverage.
    expect(document.pending.length).toBeGreaterThan(0);
  });
});

describe("rendered pages", () => {
  const rendered = {
    "/terms": renderToStaticMarkup(TermsPage()),
    "/privacy": renderToStaticMarkup(PrivacyPage()),
  } as const;

  it.each([...LEGAL_PATHS])("%s renders with a DRAFT badge", (path) => {
    expect(rendered[path]).toContain("DRAFT");
  });

  it.each([...LEGAL_PATHS])("%s renders every section heading", (path) => {
    const document =
      path === "/terms" ? LEGAL_DOCUMENTS.terms : LEGAL_DOCUMENTS.privacy;
    for (const section of document.sections) {
      expect(rendered[path]).toContain(section.heading);
    }
    for (const item of document.pending) {
      expect(rendered[path]).toContain(item);
    }
  });

  it("cross-links the two documents", () => {
    expect(rendered["/terms"]).toContain('href="/privacy"');
    expect(rendered["/privacy"]).toContain('href="/terms"');
  });
});
