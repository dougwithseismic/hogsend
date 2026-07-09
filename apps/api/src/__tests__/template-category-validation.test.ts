import type { TemplateRegistry } from "@hogsend/email";
import { describe, expect, it } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Import the engine AFTER DATABASE_URL is set so `env.ts` validates cleanly
// (mirrors analytics-provider.test.ts / lists-dataplane.test.ts).
const { createHogsendClient, defineList } = await import("@hogsend/engine");

// A template's `category` is the ONLY field this boot guard reads — the
// component is never rendered here. Build a one-entry registry with the given
// category and cast past the augmented `TemplateRegistryMap` (these keys aren't
// real app template keys, but the guard iterates `Object.entries` regardless).
const templatesWithCategory = (category: string): TemplateRegistry =>
  ({
    "test/gated": {
      component: () => null,
      defaultSubject: "Test subject",
      category,
    },
  }) as unknown as TemplateRegistry;

const productUpdates = defineList({
  id: "product-updates",
  name: "Product updates",
  defaultOptIn: false,
});

// ===========================================================================
// Compliance-critical boot guard: a template `category` is the email-preferences
// list key. A TYPO'd category resolves to an UNKNOWN list id at send time, whose
// `?? true` legacy fallback treats the recipient as subscribed → the opt-in /
// consent email is delivered to everyone (CAN-SPAM/GDPR-grade). The container
// fails CLOSED at boot when a category is neither a reserved built-in nor a
// defined list, and WARNS (doesn't throw) for a DEFINED-but-DISABLED list.
// ===========================================================================
describe("createHogsendClient — template category boot validation", () => {
  it("THROWS when a category is neither reserved nor a defined list (typo)", () => {
    let err: Error | undefined;
    try {
      // "product-update" is a typo of the "product-updates" list id.
      createHogsendClient({
        email: { templates: templatesWithCategory("product-update") },
        lists: [productUpdates],
      });
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeDefined();
    // Names the offending TEMPLATE KEY…
    expect(err?.message).toContain('"test/gated"');
    // …the BAD category…
    expect(err?.message).toContain('"product-update"');
    // …the known (defined) list ids…
    expect(err?.message).toContain("product-updates");
    // …and the reserved built-ins.
    expect(err?.message).toContain("transactional");
    expect(err?.message).toContain("journey");
  });

  it("does NOT throw for a category matching a defined, ENABLED list", async () => {
    let client: ReturnType<typeof createHogsendClient> | undefined;
    expect(() => {
      client = createHogsendClient({
        email: { templates: templatesWithCategory("product-updates") },
        lists: [productUpdates],
      });
    }).not.toThrow();
    expect(client).toBeDefined();
    await client?.dbClient.end({ timeout: 5 }).catch(() => {});
  });

  it("does NOT throw for the reserved built-in categories (transactional / journey, case-insensitive)", async () => {
    const clients: Array<ReturnType<typeof createHogsendClient>> = [];
    for (const reserved of ["transactional", "journey", "Journey"]) {
      let client: ReturnType<typeof createHogsendClient> | undefined;
      expect(() => {
        // No `lists` at all — reserved built-ins are always valid categories.
        client = createHogsendClient({
          email: { templates: templatesWithCategory(reserved) },
        });
      }).not.toThrow();
      expect(client).toBeDefined();
      if (client) clients.push(client);
    }
    for (const c of clients) {
      await c.dbClient.end({ timeout: 5 }).catch(() => {});
    }
  });

  it("does NOT throw for an `enabled:false` list — the registry filters on ENABLED_LISTS only, so it is STILL registered/gated", async () => {
    // IMPORTANT: `buildListRegistry` registers on the ENABLED_LISTS filter ONLY
    // and never consults `meta.enabled`; ENABLED_LISTS defaults to "*". So a
    // `defineList({ enabled:false })` with no ENABLED_LISTS override is STILL in
    // the registry → `listRegistry.has()` is true → it takes the registered-OK
    // path (its suppression IS gated). This proves an `enabled:false` list is a
    // valid, gated template category — NOT the registry-excluded branch.
    const enabledFalse = defineList({
      id: "beta-news",
      name: "Beta news",
      defaultOptIn: false,
      enabled: false,
    });
    let client: ReturnType<typeof createHogsendClient> | undefined;
    expect(() => {
      client = createHogsendClient({
        email: { templates: templatesWithCategory("beta-news") },
        lists: [enabledFalse],
      });
    }).not.toThrow();
    expect(client).toBeDefined();
    await client?.dbClient.end({ timeout: 5 }).catch(() => {});
  });

  it("THROWS for an OPT-IN list EXCLUDED via ENABLED_LISTS (excluding it flips the consent gate open)", () => {
    // The REAL registry-excluded branch: an opt-in list (defaultOptIn:false)
    // filtered out of the registry by an ENABLED_LISTS allowlist that doesn't
    // name it. At send time the excluded id falls back to the legacy `?? true`
    // opt-in default, so a never-consented recipient becomes "subscribed" and
    // the opt-in email ships — a consent bypass. Must fail CLOSED.
    const optIn = defineList({
      id: "changelog",
      name: "Changelog",
      defaultOptIn: false,
    });
    let err: Error | undefined;
    try {
      createHogsendClient({
        email: { templates: templatesWithCategory("changelog") },
        lists: [optIn],
        enabledLists: "some-other-list",
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain('"test/gated"');
    expect(err?.message).toContain('"changelog"');
    expect(err?.message).toContain("OPT-IN");
    expect(err?.message).toContain("ENABLED_LISTS");
  });

  it("does NOT throw (WARNS) for an OPT-OUT list EXCLUDED via ENABLED_LISTS (behavior-preserving)", async () => {
    // An opt-out list (defaultOptIn:true): both registered and registry-excluded
    // compute `categories[id] !== false`, so excluding it is behavior-preserving
    // at send time → WARN, never throw. (The warn rides the container's winston
    // logger; the vitest suite runs at LOG_LEVEL=error, which filters warn before
    // any transport, so it is not asserted here — no-throw proves the opt-in-vs-
    // opt-out THROW/WARN split.)
    const optOut = defineList({
      id: "newsletter",
      name: "Newsletter",
      defaultOptIn: true,
    });
    let client: ReturnType<typeof createHogsendClient> | undefined;
    expect(() => {
      client = createHogsendClient({
        email: { templates: templatesWithCategory("newsletter") },
        lists: [optOut],
        enabledLists: "some-other-list",
      });
    }).not.toThrow();
    expect(client).toBeDefined();
    await client?.dbClient.end({ timeout: 5 }).catch(() => {});
  });

  it("does NOT throw when a template has no category (nothing to gate)", async () => {
    const noCategory = {
      "test/no-category": {
        component: () => null,
        defaultSubject: "No category",
      },
    } as unknown as TemplateRegistry;
    let client: ReturnType<typeof createHogsendClient> | undefined;
    expect(() => {
      client = createHogsendClient({ email: { templates: noCategory } });
    }).not.toThrow();
    expect(client).toBeDefined();
    await client?.dbClient.end({ timeout: 5 }).catch(() => {});
  });
});
