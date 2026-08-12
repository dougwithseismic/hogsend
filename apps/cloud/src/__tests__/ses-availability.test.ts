import { beforeEach, describe, expect, it } from "vitest";
import {
  resetSesAvailabilityCache,
  resolveSesAvailability,
  SES_ACCOUNT_TTL_MS,
} from "../services/ses-availability";
import type { SesClient } from "../ses/contract";
import { FakeSesClient } from "../ses/fake";
import { SesError } from "../ses/types";

/**
 * The gate that decides whether a newly provisioned instance SENDS through
 * Hogsend Email.
 *
 * It used to be `ses.id === AWS_SES_ID`, which answers "do we hold real AWS
 * credentials" — a different question from "can this account send mail". The
 * account behind those credentials is in the SES SANDBOX until AWS grants
 * production access: 200 messages a day, and only to addresses we verified
 * ourselves. Promoting the credentials to Railway with the old check would
 * have activated Hogsend Email on every provision and every customer send
 * would have come back `MessageRejected`.
 *
 * Nothing here reaches AWS: the Fake answers `getAccount`, wearing the AWS
 * client's id where the test needs the credential-bearing path.
 */

/** The Fake, wearing the AWS client's id — a client that HOLDS credentials. */
function asAwsClient(client: SesClient): SesClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "id") return "aws";
      return Reflect.get(target, property, target);
    },
  }) as SesClient;
}

function fakeClient(): FakeSesClient {
  return new FakeSesClient({ region: "us" });
}

function getAccountCalls(client: FakeSesClient): number {
  return client.calls.filter((call) => call.method === "getAccount").length;
}

describe("resolveSesAvailability", () => {
  beforeEach(() => {
    resetSesAvailabilityCache();
  });

  it("refuses a SANDBOX account even though the credentials are real", async () => {
    // THE bug. The client holds AWS credentials — the old check would have
    // said `available: true` here and activated Hogsend Email on an account
    // that can only mail its own verified addresses.
    const fake = fakeClient();
    expect((await fake.getAccount()).productionAccessEnabled).toBe(false);

    const answer = await resolveSesAvailability(asAwsClient(fake));

    expect(answer.available).toBe(false);
    expect(answer.reason).toBe("sandbox");
    // Legible, not a code: an operator reading a provision must not have to
    // guess why the instance came up on another provider.
    expect(answer.detail).toMatch(/sandbox/i);
  });

  it("means MORE than 'we hold credentials': the same client flips on production access", async () => {
    // The regression guard the acceptance criteria name. One client, one id,
    // two answers — impossible for any check that reads only `ses.id`.
    const fake = fakeClient();
    const client = asAwsClient(fake);

    expect((await resolveSesAvailability(client)).available).toBe(false);

    fake.__grantProductionAccess();
    resetSesAvailabilityCache();

    const granted = await resolveSesAvailability(client);
    expect(granted.available).toBe(true);
    expect(granted.reason).toBeNull();
  });

  it("refuses when the control plane holds no AWS credentials, without calling AWS", async () => {
    const fake = fakeClient();
    fake.__grantProductionAccess();

    const answer = await resolveSesAvailability(fake);

    expect(answer.available).toBe(false);
    expect(answer.reason).toBe("no-aws-credentials");
    // No round trip: there is no account to read, and the tenancy was minted
    // in memory anyway.
    expect(getAccountCalls(fake)).toBe(0);
  });

  it("refuses when account-level sending is PAUSED, production access or not", async () => {
    const fake = fakeClient();
    fake.__grantProductionAccess().__pauseAccount();

    const answer = await resolveSesAvailability(asAwsClient(fake));

    expect(answer.available).toBe(false);
    expect(answer.reason).toBe("account-sending-paused");
  });

  it("fails CLOSED when the account cannot be read", async () => {
    // Indeterminate is NOT available. An instance that does not activate
    // Hogsend Email is a working instance on another provider; one that
    // activates it on an account we could not read is a broken product.
    const fake = fakeClient();
    fake.__grantProductionAccess();
    fake.failNext(
      "getAccount",
      new SesError("fake SES: no ses:GetAccount grant", {
        kind: "invalid",
        operation: "getAccount",
      }),
    );

    const answer = await resolveSesAvailability(asAwsClient(fake));

    expect(answer.available).toBe(false);
    expect(answer.reason).toBe("account-unreadable");
    expect(answer.detail).toMatch(/ses:GetAccount/);
  });

  it("does NOT cache an unreadable answer — the next provision retries", async () => {
    const fake = fakeClient();
    fake.__grantProductionAccess();
    fake.failNext("getAccount");
    const client = asAwsClient(fake);

    expect((await resolveSesAvailability(client)).reason).toBe(
      "account-unreadable",
    );
    // A transient throttle must not pin the whole fleet to "unavailable" for
    // the whole TTL — that would provision instances onto the wrong provider
    // for ten minutes after a blip.
    expect((await resolveSesAvailability(client)).available).toBe(true);
    expect(getAccountCalls(fake)).toBe(2);
  });

  it("caches the account answer: no AWS round trip per provision", async () => {
    const fake = fakeClient();
    fake.__grantProductionAccess();
    const client = asAwsClient(fake);

    for (let i = 0; i < 5; i += 1) {
      expect((await resolveSesAvailability(client)).available).toBe(true);
    }
    expect(getAccountCalls(fake)).toBe(1);
  });

  it("re-reads once the cache entry expires, so a granted account goes live", async () => {
    const fake = fakeClient();
    const client = asAwsClient(fake);
    let now = 1_000;

    expect(
      (await resolveSesAvailability(client, { now: () => now })).available,
    ).toBe(false);

    // AWS granted production access in the meantime. Nobody redeploys the
    // control plane for that.
    fake.__grantProductionAccess();
    now += SES_ACCOUNT_TTL_MS - 1;
    expect(
      (await resolveSesAvailability(client, { now: () => now })).available,
    ).toBe(false);
    expect(getAccountCalls(fake)).toBe(1);

    now += 2;
    expect(
      (await resolveSesAvailability(client, { now: () => now })).available,
    ).toBe(true);
    expect(getAccountCalls(fake)).toBe(2);
  });

  it("caches per REGION: SES production access is granted region by region", async () => {
    const us = new FakeSesClient({ region: "us" });
    const eu = new FakeSesClient({ region: "eu" });
    us.__grantProductionAccess();

    expect((await resolveSesAvailability(asAwsClient(us))).available).toBe(
      true,
    );
    expect((await resolveSesAvailability(asAwsClient(eu))).available).toBe(
      false,
    );
    expect(getAccountCalls(eu)).toBe(1);
  });
});
