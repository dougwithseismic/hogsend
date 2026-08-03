import { describe, expect, it } from "vitest";
import { metadata as apiDocs } from "../../app/api-docs/page";
import { metadata as environments } from "../../app/environments/page";
import { metadata as login } from "../../app/login/page";
import { metadata as notFound } from "../../app/not-found";
import { metadata as overview } from "../../app/page";
import { metadata as privacy } from "../../app/privacy/page";
import { metadata as settings } from "../../app/settings/page";
import { metadata as signup } from "../../app/signup/page";
import { metadata as terms } from "../../app/terms/page";
import { metadata as usage } from "../../app/usage/page";

/**
 * Every route names itself in the browser tab and in a shared link. Cheap to
 * assert and easy to forget on a new page, which is exactly the kind of gap a
 * test is for — a page inheriting the bare "Hogsend Cloud" default is
 * indistinguishable from every other tab.
 */

const ROUTES = [
  { path: "/", metadata: overview },
  { path: "/environments", metadata: environments },
  { path: "/usage", metadata: usage },
  { path: "/settings", metadata: settings },
  { path: "/login", metadata: login },
  { path: "/signup", metadata: signup },
  { path: "/terms", metadata: terms },
  { path: "/privacy", metadata: privacy },
  { path: "/api-docs", metadata: apiDocs },
  { path: "404", metadata: notFound },
] as const;

// `app/layout.tsx` is deliberately NOT imported: it pulls in `next/font`,
// which only exists inside the Next compiler and throws under plain vitest.
// The layout's title template is what appends " — Hogsend Cloud"; what is
// testable here is that each page supplies its own half of it.
describe("route metadata", () => {
  it.each(ROUTES)("$path exports its own title", ({ metadata }) => {
    expect(typeof metadata.title).toBe("string");
    expect(metadata.title as string).not.toBe("");
    // The layout appends " — Hogsend Cloud"; a page repeating it would double.
    expect(metadata.title as string).not.toContain("Hogsend Cloud");
  });

  it("marks the legal pages as drafts in the tab title too", () => {
    for (const document of [terms, privacy]) {
      expect(document.title as string).toMatch(/draft/i);
    }
  });
});
