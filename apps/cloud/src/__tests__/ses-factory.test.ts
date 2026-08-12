import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AwsSesClient } from "../ses/aws";
import { FakeSesClient } from "../ses/fake";
import { getFakeSesClient, getSesClient, resetSesClients } from "../ses/index";
import { SesError } from "../ses/types";

/**
 * The composition root. Its only job is picking an implementation, and the two
 * ways that goes wrong are both asserted here:
 *  - silently running the FAKE in production, which would report emails that
 *    were never sent;
 *  - booting on HALF a credential pair, which fails at the first provision
 *    instead of at deploy time (DECISIONS §7.1).
 *
 * No client built here ever reaches AWS: constructing an `SESv2Client` opens
 * nothing, and no verb is invoked.
 */

const KEY = "CLOUD_AWS_ACCESS_KEY_ID";
const SECRET = "CLOUD_AWS_SECRET_ACCESS_KEY";

let saved: { key?: string; secret?: string };

beforeEach(() => {
  saved = { key: process.env[KEY], secret: process.env[SECRET] };
  delete process.env[KEY];
  delete process.env[SECRET];
  resetSesClients();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  if (saved.key === undefined) delete process.env[KEY];
  else process.env[KEY] = saved.key;
  if (saved.secret === undefined) delete process.env[SECRET];
  else process.env[SECRET] = saved.secret;
  resetSesClients();
  vi.restoreAllMocks();
});

function logLines(): string[] {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .filter((line) => line.startsWith("[cloud:ses]"));
}

describe("getSesClient", () => {
  it("yields the Fake with no credentials, and says so once", () => {
    const client = getSesClient("us");

    expect(client).toBeInstanceOf(FakeSesClient);
    expect(logLines()).toEqual([
      "[cloud:ses] client=fake region=us aws_region=us-east-1",
    ]);
  });

  it("yields the AWS client when BOTH credentials are present", () => {
    process.env[KEY] = "AKIAFAKE";
    process.env[SECRET] = "secret";

    const client = getSesClient("eu");

    expect(client).toBeInstanceOf(AwsSesClient);
    expect(client.awsRegion).toBe("eu-west-1");
    expect(logLines()).toEqual([
      "[cloud:ses] client=aws region=eu aws_region=eu-west-1",
    ]);
  });

  it("refuses to boot on HALF a credential pair", () => {
    process.env[KEY] = "AKIAFAKE";

    const error = (() => {
      try {
        getSesClient("us");
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    // Degrading to the Fake here would mean a production control plane that
    // reports provisioned tenants which do not exist.
    expect(error).toBeInstanceOf(SesError);
    expect((error as SesError).kind).toBe("invalid");
    expect((error as SesError).message).toContain(KEY);
    expect((error as SesError).message).toContain(SECRET);

    resetSesClients();
    delete process.env[KEY];
    process.env[SECRET] = "secret";
    expect(() => getSesClient("us")).toThrow(SesError);
  });

  it("treats a blank credential as absent rather than as configured", () => {
    process.env[KEY] = "  ";
    process.env[SECRET] = "";

    expect(getSesClient("us")).toBeInstanceOf(FakeSesClient);
  });

  it("holds ONE client per region", () => {
    const us = getSesClient("us");
    const usAgain = getSesClient("us");
    const eu = getSesClient("eu");

    // Tenants are region-scoped and do not replicate: one client per region,
    // and never a shared one that could target the wrong account surface.
    expect(usAgain).toBe(us);
    expect(eu).not.toBe(us);
    expect(eu.awsRegion).toBe("eu-west-1");
    // One line per region, not one per call.
    expect(logLines()).toHaveLength(2);
  });

  it("rejects a region outside the mapping", () => {
    expect(() => getSesClient("ap-south-1" as "us")).toThrow(SesError);
  });
});

describe("getFakeSesClient", () => {
  it("hands back the process-wide fake for the region", () => {
    const fake = getFakeSesClient("us");
    expect(fake).toBe(getSesClient("us"));
  });

  it("refuses when the AWS client is the active one", () => {
    process.env[KEY] = "AKIAFAKE";
    process.env[SECRET] = "secret";

    expect(() => getFakeSesClient("us")).toThrow(SesError);
  });
});
