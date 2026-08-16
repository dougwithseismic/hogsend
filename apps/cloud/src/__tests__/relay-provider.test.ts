import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFakeRelay, getRelay, SesRelayProvider } from "../relay/index";
import { FakeSesClient } from "../ses/fake";
import { getFakeSesClient, resetSesClients } from "../ses/index";
import type { SesMessage } from "../ses/types";
import { SesError } from "../ses/types";
import type { SubstrateRegion } from "../substrate/types";

/**
 * The relay seam (`src/relay`) — the provider-neutral wire the control plane
 * sends outbound mail through.
 *
 * `SesRelayProvider` is a THIN adapter over the frozen SES seam, so every
 * assertion here is about faithfulness: the send result carries the fake's own
 * message id under the neutral `id`, the batch result is the fake's `{ results }`
 * unchanged, and a `SesError` rides OUT of the relay with its `kind` intact
 * rather than being swallowed. No test reaches AWS — the suite runs with no
 * credentials, so the process-wide client is always the Fake.
 */

const DOMAIN = "acme.test";
const IDENTITY_ARN = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;
const TENANT = "env-relay-test";

/** Put a fresh fake into a fully provisioned, send-ready state — a verified
 * identity associated with the tenant, exactly what the wire requires. */
async function sendReadyFake(): Promise<FakeSesClient> {
  const ses = new FakeSesClient({ region: "us" });
  await ses.createTenant({ tenantName: TENANT });
  await ses.createIdentity({ domain: DOMAIN });
  ses.__verifyIdentity(DOMAIN);
  await ses.associateResource({
    tenantName: TENANT,
    resourceArn: IDENTITY_ARN,
  });
  return ses;
}

function message(to: string[] = ["recipient@example.com"]): SesMessage {
  return {
    from: `Acme <hello@${DOMAIN}>`,
    to,
    subject: "hi",
    html: "<p>hi</p>",
  };
}

beforeEach(() => {
  resetSesClients();
});

afterEach(() => {
  resetSesClients();
});

describe("SesRelayProvider", () => {
  it("send returns the underlying messageId as the neutral id", async () => {
    const ses = await sendReadyFake();
    const relay = new SesRelayProvider(ses);

    const result = await relay.send({
      tenantName: TENANT,
      configurationSetName: "cs",
      message: message(),
    });

    const sent = ses.calls.filter((c) => c.method === "sendEmail");
    expect(sent).toHaveLength(1);
    // The id the fake minted, now under `id` rather than `messageId`.
    expect(result).toEqual({ id: "fake-ses-message-1" });
  });

  it("sendBatch returns the underlying { results } per-entry shape unchanged", async () => {
    const ses = await sendReadyFake();
    const relay = new SesRelayProvider(ses);

    const input = {
      tenantName: TENANT,
      configurationSetName: "cs",
      messages: [message(["a@example.com"]), message(["b@example.com"])],
    };
    const viaRelay = await relay.sendBatch(input);

    // The relay is a pure pass-through, so a second identical batch on a fresh
    // fake produces the identical result object.
    const ses2 = await sendReadyFake();
    const viaClient = await ses2.sendBatch(input);

    expect(viaRelay).toEqual(viaClient);
    expect(viaRelay.results).toEqual([
      { status: "sent", messageId: "fake-ses-message-1" },
      { status: "sent", messageId: "fake-ses-message-2" },
    ]);
  });

  it("propagates a SesError out of send unchanged (instanceof + kind)", async () => {
    const ses = await sendReadyFake();
    ses.failNext(
      "sendEmail",
      new SesError("fake SES: slow down", {
        kind: "throttled",
        operation: "sendEmail",
      }),
    );
    const relay = new SesRelayProvider(ses);

    await expect(
      relay.send({
        tenantName: TENANT,
        configurationSetName: "cs",
        message: message(),
      }),
    ).rejects.toMatchObject({ kind: "throttled" });

    // The SAME error instance and class, not a re-wrap.
    let caught: unknown;
    ses.failNext(
      "sendEmail",
      new SesError("again", { kind: "throttled", operation: "sendEmail" }),
    );
    try {
      await relay.send({
        tenantName: TENANT,
        configurationSetName: "cs",
        message: message(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SesError);
    expect((caught as SesError).kind).toBe("throttled");
    expect((caught as SesError).retryable).toBe(true);
  });
});

describe("getRelay", () => {
  it("returns a working provider over the process-wide fake", async () => {
    const relay = getRelay("us");
    expect(relay.meta).toEqual({ id: "ses", region: "us" });
    // A fresh wrapper each call — `getRelay` holds no cache of its own; the
    // per-region caching lives one layer down in `getSesClient`, so two calls
    // are distinct wrappers over the SAME cached client (proven by the send
    // below succeeding against the shared fake).
    expect(getRelay("us")).not.toBe(relay);

    // Seed the SAME process-wide fake `getRelay` wraps, then send through the
    // relay — proving the wiring reaches a live client, not a fresh empty one.
    const shared = getFakeSesClient("us");
    await shared.createTenant({ tenantName: TENANT });
    await shared.createIdentity({ domain: DOMAIN });
    shared.__verifyIdentity(DOMAIN);
    await shared.associateResource({
      tenantName: TENANT,
      resourceArn: IDENTITY_ARN,
    });

    const result = await relay.send({
      tenantName: TENANT,
      configurationSetName: "cs",
      message: message(),
    });
    expect(result).toEqual({ id: "fake-ses-message-1" });

    // The explicit fake helper wraps the same process-wide fake.
    expect(getFakeRelay("us").meta).toEqual({ id: "ses", region: "us" });
  });

  it("throws for an unmapped region exactly as getSesClient does", () => {
    expect(() => getRelay("ap-south-1" as SubstrateRegion)).toThrow(SesError);
    expect(() => getRelay("ap-south-1" as SubstrateRegion)).toThrow(
      /unsupported SES region/,
    );
  });
});
