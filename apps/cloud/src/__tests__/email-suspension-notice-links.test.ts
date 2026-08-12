import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  renderReinstatementNotice,
  renderSuspensionNotice,
} from "../lib/email-suspension-notice";

/**
 * The suspension notice links a suspended paying customer to the published
 * Acceptable Use Policy. That link 404ing is the failure this file pins:
 * every `hogsend.com` path the notice emits must be a route the public site
 * (`apps/docs`) actually publishes.
 *
 * Scoped deliberately to the bare `hogsend.com` host. The
 * `cloud.hogsend.com/environments/{{environment}}` link is reproduced from
 * the source document as written and is flagged there as pending
 * confirmation — it is a dashboard link, not a docs route, and is not
 * asserted here.
 */

const DOCS_APP_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../docs/app",
);

/**
 * Every static route the docs app publishes: walk the Next app router tree,
 * drop route-group segments `(group)`, and record the path of each page file.
 */
function collectStaticRoutes(dir: string, segments: string[] = []): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const isGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
      routes.push(
        ...collectStaticRoutes(
          join(dir, entry.name),
          isGroup ? segments : [...segments, entry.name],
        ),
      );
    } else if (entry.name === "page.tsx" || entry.name === "page.mdx") {
      routes.push(`/${segments.join("/")}`);
    }
  }
  return routes;
}

/** The pathnames of every `https://hogsend.com/...` link in a notice body. */
function hogsendComPaths(text: string): string[] {
  return [...text.matchAll(/https:\/\/hogsend\.com(\/[\w\-/]*)/g)].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );
}

describe("suspension notice link targets", () => {
  const routes = new Set(collectStaticRoutes(DOCS_APP_DIR));

  it("walks a real docs app — the guard against a vacuous pass", () => {
    // If apps/docs moves or the walk breaks, fail HERE, loudly — not by
    // asserting membership against an empty set further down.
    expect(routes.size).toBeGreaterThan(0);
    expect(routes.has("/terms")).toBe(true);
  });

  it("every hogsend.com link in the suspension notice is a published route", () => {
    const notice = renderSuspensionNotice({
      variant: "automatic",
      environment: "production",
      suspendedAt: new Date("2026-08-10T14:32:00Z"),
      clause: "5.1",
      cause: "Complaint rate crossed the review threshold.",
    });

    const paths = hogsendComPaths(notice.text);
    // The "Full policy" link is the one that shipped as a 404. If the regex
    // ever stops extracting it, this line keeps the loop below from passing
    // over an empty list.
    expect(paths).toContain("/acceptable-use");
    for (const path of paths) {
      expect(
        routes.has(path),
        `the notice links https://hogsend.com${path} but apps/docs publishes no such route`,
      ).toBe(true);
    }
  });

  it("the no-appeal variant and the reinstatement notice link only published routes", () => {
    const noAppeal = renderSuspensionNotice({
      variant: "manual",
      environment: "production",
      suspendedAt: new Date("2026-08-10T14:32:00Z"),
      clause: "3.2",
      cause: "Phishing reported by a mailbox provider.",
    });
    const reinstated = renderReinstatementNotice({ environment: "production" });

    for (const path of [
      ...hogsendComPaths(noAppeal.text),
      ...hogsendComPaths(reinstated.text),
    ]) {
      expect(
        routes.has(path),
        `a notice links https://hogsend.com${path} but apps/docs publishes no such route`,
      ).toBe(true);
    }
  });
});
