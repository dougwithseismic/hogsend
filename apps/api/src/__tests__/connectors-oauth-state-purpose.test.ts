import {
  createApp,
  createHogsendClient,
  defineConnector,
  signConnectorState,
} from "@hogsend/engine";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * PRD 07 T2 — the connector OAuth callback states its purpose rule EXPLICITLY.
 *
 * One secret (`BETTER_AUTH_SECRET`) signs every state in the process, so an
 * `account_link` state minted for the hosted flow is signature-valid at the
 * connector callback too. Two things reject it today and they are deliberately
 * asserted SEPARATELY so neither test can alias the other:
 *
 *  1. the `connectorId !== id` check (incidental: an account-link state carries
 *     no `connectorId`, and `undefined !== id`), and
 *  2. the purpose allowlist (explicit).
 *
 * Defence that only works because a plugin happens to have an exhaustive `else`
 * is defence a new plugin can drop.
 */

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";

/** Records every dispatch so "the handler was never reached" is a real claim. */
const dispatched: string[] = [];

const probeConnector = defineConnector({
  meta: { id: "purposeprobe", name: "Purpose Probe", transport: "webhook" },
  inboundVerify: { type: "match", header: "x-probe", envKey: "PROBE_SECRET" },
  async transform() {
    return null;
  },
  handlers: {
    async oauthCallback({ state }) {
      dispatched.push(state.purpose);
      return { kind: "json", status: 200, body: { ok: true } };
    },
  },
});

const container = createHogsendClient({ connectors: [probeConnector] });
const app = createApp(container);

beforeEach(() => {
  dispatched.length = 0;
});

describe("connector oauth callback — state purpose allowlist", () => {
  it("an account_link state is rejected at the connector oauth callback", async () => {
    const state = signConnectorState(
      {
        purpose: "account_link",
        providerId: "purposeprobe",
        // The grafting shape: a state that names the connector as its provider
        // and seals a contact. It must not dispatch.
        contactId: "11111111-2222-3333-4444-555555555555",
        nonce: `purpose-${crypto.randomUUID()}`,
      },
      SECRET,
      900,
    );

    const res = await app.request(
      `/v1/connectors/purposeprobe/oauth/callback?state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid state" });
    expect(dispatched).toEqual([]);
  });

  it("an account_link state that ALSO carries a matching connectorId is still rejected", async () => {
    // This is the mutation-guard's twin: it defeats the incidental
    // `connectorId !== id` rejection, so ONLY the explicit purpose allowlist
    // can reject it. Remove the allowlist and this test fails on its own.
    const state = signConnectorState(
      {
        purpose: "account_link",
        providerId: "purposeprobe",
        connectorId: "purposeprobe",
        contactId: "11111111-2222-3333-4444-555555555555",
        nonce: `purpose-${crypto.randomUUID()}`,
      },
      SECRET,
      900,
    );

    const res = await app.request(
      `/v1/connectors/purposeprobe/oauth/callback?state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(400);
    expect(dispatched).toEqual([]);
  });

  it("an install state for this connector still dispatches", async () => {
    // The non-vacuity control: the route is reachable and the handler does run
    // for a legal purpose, so the two rejections above are the guards talking.
    const state = signConnectorState(
      {
        purpose: "install",
        connectorId: "purposeprobe",
        nonce: `purpose-${crypto.randomUUID()}`,
      },
      SECRET,
      900,
    );

    const res = await app.request(
      `/v1/connectors/purposeprobe/oauth/callback?state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(200);
    expect(dispatched).toEqual(["install"]);
  });
});
