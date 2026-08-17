import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  emailInboundMessages,
  environments,
  organizations,
  sesTenants,
  stacks,
} from "../db/schema";
import { env } from "../env";
import { encryptSecretPayload } from "../lib/crypto";
import { INBOUND_OBJECT_KEY_PREFIX } from "../lib/inbound-domains";
import { forwardInboundMessage } from "../services/email-inbound-forward";
import {
  createInboundObjectFetcher,
  type InboundS3Transport,
} from "../services/email-inbound-objects";
import { redriveStuckForwards } from "../services/email-inbound-redrive";
import { writeInboundConfig } from "../services/ses-inbound-config";
import { FakeSesClient } from "../ses/fake";
import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import { SesError } from "../ses/types";

/**
 * THE STUCK-FORWARD RE-DRIVE — the automatic half of PRD 16 task 6.
 *
 * A transient SES/tenant failure settles the inbound row terminal with only
 * `forward_error` set. No SNS redelivery re-drives a terminal row, so before
 * this sweep the reply reached the human only when an operator noticed the
 * `forwarded_at IS NULL AND forward_error IS NOT NULL` list. These tests pin
 * that the sweep now notices for them — and that it stays bounded (settled,
 * resolved, not too old) so it never becomes a herd or an infinite loop.
 *
 * Nothing reaches AWS: the S3 read and the SES send are injected.
 */

const ORG = "email-inbound-redrive-test-org";
const BUCKET = "hogsend-ses-inbound";
const DOMAIN = "redrive-tenant.test";
const HUMAN = `support@${DOMAIN}`;
const INSTANCE = "https://redrive-tenant.hogsend.app";
const SECRET = "redrive-tenant-webhook-secret-abcdefghij";
const IDENTITY_ARN = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;

let environmentId: string;
let seq = 0;

function freshMessageId(): string {
  seq += 1;
  return `0100031${String(seq).padStart(4, "0")}-redrive-test-000000`;
}

function rawMessage(text: string): Uint8Array {
  const headers = [
    "From: Human Sender <human@sender.test>",
    `To: hello@reply.${DOMAIN}`,
    "Subject: Re: your onboarding email",
    "Date: Wed, 12 Aug 2026 09:14:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
  ];
  return new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n${text}\r\n`);
}

function fakeS3(objects: Map<string, Uint8Array>) {
  const transport: InboundS3Transport = {
    async head(ref) {
      const body = objects.get(ref.key);
      if (!body) throw new Error(`no such key: ${ref.key}`);
      return { size: body.byteLength };
    },
    async get(ref) {
      const body = objects.get(ref.key);
      if (!body) throw new Error(`no body for key: ${ref.key}`);
      return { body };
    },
  };
  return createInboundObjectFetcher(() => transport);
}

async function sendReadyFake(): Promise<FakeSesClient> {
  const ses = new FakeSesClient({ region: "us" });
  const tenantName = sesTenantName(environmentId);
  await ses.createTenant({ tenantName });
  await ses.createIdentity({ domain: DOMAIN });
  ses.__verifyIdentity(DOMAIN);
  await ses.associateResource({ tenantName, resourceArn: IDENTITY_ARN });
  return ses;
}

/** Seed one row already SETTLED with a forwarding failure, nothing forwarded. */
async function seedStuckRow(opts: {
  text?: string;
  createdAt?: Date;
  updatedAt?: Date;
  forwardError?: string | null;
  forwardedAt?: Date | null;
  status?: "delivered" | "suppressed";
  reason?: string | null;
  environmentId?: string | null;
}): Promise<{ id: string; messageId: string; key: string }> {
  const messageId = freshMessageId();
  const key = `${INBOUND_OBJECT_KEY_PREFIX}${messageId}`;
  const now = new Date();
  const [row] = await db
    .insert(emailInboundMessages)
    .values({
      environmentId:
        opts.environmentId === undefined ? environmentId : opts.environmentId,
      region: "us",
      dedupeKey: `dedupe-${messageId}`,
      sesMessageId: messageId,
      recipient: `hello@reply.${DOMAIN}`,
      recipients: [`hello@reply.${DOMAIN}`],
      domain: DOMAIN,
      bucket: BUCKET,
      objectKey: key,
      status: opts.status ?? "delivered",
      reason: opts.reason ?? null,
      forwardError:
        opts.forwardError === undefined ? "SES throttled" : opts.forwardError,
      forwardedAt: opts.forwardedAt ?? null,
      deliveredAt: opts.status === "suppressed" ? null : now,
      receivedAt: now,
      createdAt: opts.createdAt ?? new Date(now.getTime() - 10 * 60 * 1000),
      updatedAt: opts.updatedAt ?? new Date(now.getTime() - 10 * 60 * 1000),
    })
    .returning({ id: emailInboundMessages.id });
  if (!row) throw new Error("failed to seed inbound row");
  return { id: row.id, messageId, key };
}

async function fetchRow(id: string) {
  const [row] = await db
    .select()
    .from(emailInboundMessages)
    .where(eq(emailInboundMessages.id, id));
  return row;
}

async function cleanupRows(): Promise<void> {
  await db
    .delete(emailInboundMessages)
    .where(eq(emailInboundMessages.region, "us"));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanupRows();
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Email Inbound Redrive Test", region: "us" });

  const [environment] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: "redrive-env", kind: "test" })
    .returning();
  if (!environment) throw new Error("failed to seed environment");
  environmentId = environment.id;

  await db.insert(stacks).values({
    organizationId: ORG,
    environmentId,
    region: "us",
    status: "running",
    substrateRefs: { substrate: "fake", apiPublicUrl: INSTANCE, data: {} },
  });
  await db.insert(sesTenants).values({
    environmentId,
    tenantName: sesTenantName(environmentId),
    tenantArn: `arn:aws:ses:us-east-1:123456789012:tenant/${sesTenantName(
      environmentId,
    )}`,
    configurationSetName: sesConfigurationSetName(environmentId),
    region: "us",
    awsRegion: "us-east-1",
    webhookSecretEncrypted: encryptSecretPayload(SECRET),
    available: true,
  });
  await writeInboundConfig(
    {
      environmentId,
      domain: DOMAIN,
      config: { forwardTo: HUMAN, label: "reply" },
    },
    { db },
  );
});

beforeEach(async () => {
  // Each test owns its own rows: a leftover stuck row would be re-selected by a
  // later test's sweep and pollute the assertions.
  await cleanupRows();
});

afterAll(async () => {
  await cleanupRows();
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
  await sqlClient.end();
});

describe("redriveStuckForwards", () => {
  it("selects a stuck row, re-forwards it, and clears the error", async () => {
    const seeded = await seedStuckRow({ text: "please call me back" });
    const ses = await sendReadyFake();

    const result = await redriveStuckForwards({
      db,
      fetchObject: fakeS3(
        new Map([[seeded.key, rawMessage("please call me back")]]),
      ),
      forward: (input) => forwardInboundMessage(input, { db, ses }),
    });

    // The sweep found and re-drove exactly this row.
    expect(result.forwarded).toContain(seeded.id);
    expect(result.stillFailing).toEqual([]);

    // The human actually received the reply — full body, to the configured
    // address — rather than only appearing on an operator's list.
    const sent = ses.__sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.to).toEqual([HUMAN]);
    expect(sent[0]?.message.text).toContain("please call me back");

    // The row is now stamped and the error cleared, so the next tick skips it.
    const row = await fetchRow(seeded.id);
    expect(row?.forwardedAt).toBeInstanceOf(Date);
    expect(row?.forwardError).toBeNull();
  });

  it("re-records the error and leaves the row when SES fails again", async () => {
    const seeded = await seedStuckRow({ text: "still down" });
    const ses = await sendReadyFake();
    // Fetch + parse succeed, but the send throws again — the transient failure
    // has not cleared, so the row stays stuck for the next tick.
    ses.failNext(
      "sendEmail",
      new SesError("SES still throttled", {
        kind: "throttled",
        operation: "sendEmail",
      }),
    );

    const result = await redriveStuckForwards({
      db,
      fetchObject: fakeS3(new Map([[seeded.key, rawMessage("still down")]])),
      forward: (input) => forwardInboundMessage(input, { db, ses }),
    });

    expect(result.stillFailing).toContain(seeded.id);
    expect(result.forwarded).toEqual([]);
    const row = await fetchRow(seeded.id);
    expect(row?.forwardedAt).toBeNull();
    expect(row?.forwardError).toContain("still throttled");
  });

  it("ignores a row whose failure was recorded too recently", async () => {
    const now = new Date();
    const seeded = await seedStuckRow({
      updatedAt: new Date(now.getTime() - 5 * 1000), // 5s ago — still settling
      createdAt: new Date(now.getTime() - 5 * 1000),
    });
    const ses = await sendReadyFake();

    const result = await redriveStuckForwards({
      db,
      now: () => now.getTime(),
      minStaleMs: 60 * 1000,
      fetchObject: fakeS3(new Map([[seeded.key, rawMessage("too soon")]])),
      forward: (input) => forwardInboundMessage(input, { db, ses }),
    });

    expect(result.forwarded).not.toContain(seeded.id);
    expect(ses.__sent()).toEqual([]);
    expect((await fetchRow(seeded.id))?.forwardedAt).toBeNull();
  });

  it("gives up on a row older than the max age, leaving it for an operator", async () => {
    const now = new Date();
    const seeded = await seedStuckRow({
      createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000), // 2 days old
      updatedAt: new Date(now.getTime() - 47 * 60 * 60 * 1000),
    });
    const ses = await sendReadyFake();

    const result = await redriveStuckForwards({
      db,
      now: () => now.getTime(),
      maxAgeMs: 24 * 60 * 60 * 1000,
      fetchObject: fakeS3(new Map([[seeded.key, rawMessage("ancient")]])),
      forward: (input) => forwardInboundMessage(input, { db, ses }),
    });

    expect(result.forwarded).not.toContain(seeded.id);
    expect(ses.__sent()).toEqual([]);
    // Still on the row for the operator — nothing lost, the MIME is in S3.
    expect((await fetchRow(seeded.id))?.forwardError).not.toBeNull();
  });

  it("never touches an already-forwarded row or one with no error", async () => {
    const forwarded = await seedStuckRow({
      forwardedAt: new Date(),
      forwardError: null,
    });
    const clean = await seedStuckRow({ forwardError: null });
    const ses = await sendReadyFake();

    const result = await redriveStuckForwards({
      db,
      fetchObject: fakeS3(new Map()),
      forward: (input) => forwardInboundMessage(input, { db, ses }),
    });

    expect(result.forwarded).not.toContain(forwarded.id);
    expect(result.forwarded).not.toContain(clean.id);
    expect(result.stillFailing).not.toContain(clean.id);
    expect(ses.__sent()).toEqual([]);
  });
});
