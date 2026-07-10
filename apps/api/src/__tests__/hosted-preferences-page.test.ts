import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const {
  buildListRegistry,
  createApp,
  createHogsendClient,
  defineConnectorAction,
  resetListRegistry,
  synthesizeChannelLists,
} = await import("@hogsend/engine");
const { generateUnsubscribeToken } = await import("@hogsend/email");

// A member-directed action so `synthesizeChannelLists` mints a `discord`
// channel (plus the always-present in-app feed).
const discordDm = defineConnectorAction({
  connectorId: "discord",
  name: "dmMember",
  audience: {
    kind: "member",
    ref: (args: { userId: string }) => args.userId,
  },
  run: async () => ({ ok: true }),
});

const container = createHogsendClient({ connectorActions: [discordDm] });
const app = createApp(container);
const { env } = container;

const EXTERNAL_ID = "hosted-prefs-user";
const EMAIL = "hosted-prefs@example.com";

function manageToken(): string {
  return generateUnsubscribeToken({
    secret: env.BETTER_AUTH_SECRET,
    externalId: EXTERNAL_ID,
    email: EMAIL,
    action: "manage",
  });
}

async function fetchPage(): Promise<string> {
  const res = await app.request(
    `/v1/email/preferences?token=${encodeURIComponent(manageToken())}`,
  );
  expect(res.status).toBe(200);
  return res.text();
}

afterAll(() => {
  // Leave no channel metas in the process singleton for later suites.
  resetListRegistry();
});

describe("hosted preference page — channel/topic sections", () => {
  it("renders both section headings + a channel row when channels are registered", async () => {
    buildListRegistry([], undefined, synthesizeChannelLists([discordDm]));

    const html = await fetchPage();

    expect(html).toContain('<h2 class="pref-section">Channels</h2>');
    expect(html).toContain('<h2 class="pref-section">Email topics</h2>');
    // The in-app feed channel row is always present alongside its heading.
    expect(html).toContain("In-app feed");
    expect(html).toContain("Discord");
    // The built-in journey topic still renders under Email topics.
    expect(html).toContain("Journey & lifecycle emails");
  });

  it("renders no section headings when no channels exist (legacy layout)", async () => {
    buildListRegistry([], undefined, []);

    const html = await fetchPage();

    // The `.pref-section` CSS rule is always in the <style> block; assert no
    // section HEADING is rendered (byte-identical to the legacy layout body).
    expect(html).not.toContain('<h2 class="pref-section">');
    expect(html).not.toContain(">Channels<");
    expect(html).not.toContain(">Email topics<");
    // The journey topic + global master row still render, exactly as before.
    expect(html).toContain("Journey & lifecycle emails");
    expect(html).toContain("All emails");
  });
});
