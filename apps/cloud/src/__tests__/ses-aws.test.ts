import {
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
  GetEmailIdentityCommand,
  GetReputationEntityCommand,
  GetTenantCommand,
  PutEmailIdentityMailFromAttributesCommand,
  PutTenantSuppressionAttributesCommand,
  SendEmailCommand,
  UpdateConfigurationSetEventDestinationCommand,
  UpdateReputationEntityCustomerManagedStatusCommand,
  UpdateReputationEntityPolicyCommand,
} from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import type { SesCommandLike, SesTransport } from "../ses/aws";
import {
  AwsSesClient,
  classifySesError,
  SES_BACKOFF_BASE_MS,
  SES_BATCH_CONCURRENCY,
  SES_MAX_ATTEMPTS,
  sesBackoffMs,
} from "../ses/aws";
import type { SesAttachment, SesErrorKind } from "../ses/types";
import { SesError } from "../ses/types";
import type { SubstrateRegion } from "../substrate/types";

/**
 * No AWS anywhere: the SDK's `send` is an injected function, so every command
 * this client builds is inspected in memory and every failure it handles is a
 * literal shaped like a real SES exception.
 *
 * The two rules that have burned this project before get the most attention:
 *  - NEVER retry a 4xx. Proved with a call counter, not by reading the code.
 *  - NEVER discard a response body. A failed provision has to be diagnosable
 *    from the error alone, weeks later, from a log line.
 */

const TENANT = "env-11111111-1111-4111-8111-111111111111";

interface AwsErrorShape {
  status?: number;
  message?: string;
  body?: string;
  fault?: "client" | "server";
  requestId?: string;
}

/** An error shaped exactly like one the AWS SDK throws. */
function awsError(name: string, shape: AwsErrorShape = {}): Error {
  const error = new Error(shape.message ?? `${name} raised`) as Error &
    Record<string, unknown>;
  error.name = name;
  error.$fault = shape.fault ?? "client";
  error.$metadata = {
    httpStatusCode: shape.status,
    requestId: shape.requestId,
  };
  if (shape.body !== undefined) {
    error.$response = { statusCode: shape.status, body: shape.body };
  }
  return error;
}

/** Run every pending microtask to completion. A macrotask boundary is the only
 * honest way to say "and then everything that could settle, settled". */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Harness {
  client: AwsSesClient;
  commands: SesCommandLike[];
  delays: number[];
}

/** A client whose wire is a scripted responder. `respond` sees every command. */
function harness(
  respond: (command: SesCommandLike, callIndex: number) => unknown,
  options: { maxAttempts?: number; region?: SubstrateRegion } = {},
): Harness {
  const commands: SesCommandLike[] = [];
  const delays: number[] = [];
  const send: SesTransport = async (command) => {
    commands.push(command);
    return respond(command, commands.length);
  };
  return {
    commands,
    delays,
    client: new AwsSesClient({
      region: options.region ?? "us",
      send,
      sleep: async (ms) => {
        delays.push(ms);
      },
      ...options,
    }),
  };
}

describe("AwsSesClient construction", () => {
  it("requires a region inside the SubstrateRegion mapping", () => {
    expect(
      () =>
        new AwsSesClient({
          region: "ap-south-1" as "us",
          send: async () => ({}),
        }),
    ).toThrow(SesError);

    const client = new AwsSesClient({ region: "eu", send: async () => ({}) });
    expect(client.awsRegion).toBe("eu-west-1");
    expect(client.region).toBe("eu");
  });
});

describe("classifySesError", () => {
  const table: { name: string; shape: AwsErrorShape; kind: SesErrorKind }[] = [
    { name: "NotFoundException", shape: { status: 404 }, kind: "not_found" },
    {
      name: "AlreadyExistsException",
      shape: { status: 400 },
      kind: "already_exists",
    },
    {
      name: "TooManyRequestsException",
      shape: { status: 429 },
      kind: "throttled",
    },
    { name: "ThrottlingException", shape: { status: 400 }, kind: "throttled" },
    {
      name: "AccountSuspendedException",
      shape: { status: 400 },
      kind: "account_paused",
    },
    {
      name: "SendingPausedException",
      shape: { status: 400 },
      kind: "account_paused",
    },
    {
      name: "SendingPausedException",
      shape: {
        status: 400,
        message: "Sending is paused for tenant env-abc in this Region",
      },
      kind: "tenant_paused",
    },
    {
      name: "MessageRejected",
      shape: {
        status: 400,
        message: "The tenant's sending status is DISABLED",
      },
      kind: "tenant_paused",
    },
    {
      name: "MessageRejected",
      shape: { status: 400, message: "Email address is not verified" },
      kind: "invalid",
    },
    { name: "BadRequestException", shape: { status: 400 }, kind: "invalid" },
    { name: "LimitExceededException", shape: { status: 400 }, kind: "invalid" },
    {
      name: "MailFromDomainNotVerifiedException",
      shape: { status: 400 },
      kind: "invalid",
    },
    { name: "ConflictException", shape: { status: 409 }, kind: "invalid" },
    {
      name: "SomeUnannouncedException",
      shape: { status: 422 },
      kind: "invalid",
    },
    {
      name: "ConcurrentModificationException",
      shape: { status: 500, fault: "server" },
      kind: "transient",
    },
    {
      name: "InternalServiceErrorException",
      shape: { status: 500, fault: "server" },
      kind: "transient",
    },
    {
      name: "ServiceUnavailableException",
      shape: { status: 503, fault: "server" },
      kind: "transient",
    },
    { name: "TimeoutError", shape: {}, kind: "transient" },
    { name: "Error", shape: { message: "fetch failed" }, kind: "transient" },
    { name: "Error", shape: { message: "socket hang up" }, kind: "transient" },
    {
      name: "TypeError",
      shape: { message: "x is not a function" },
      kind: "unknown",
    },
  ];

  for (const row of table) {
    it(`classifies ${row.name} (${row.shape.status ?? "no status"}) as ${row.kind}`, () => {
      const error = classifySesError(
        awsError(row.name, row.shape),
        "sendEmail",
      );
      expect(error).toBeInstanceOf(SesError);
      expect(error.kind).toBe(row.kind);
      expect(error.operation).toBe("sendEmail");
      expect(error.awsErrorName).toBe(row.name);
    });
  }

  it("marks exactly the two retryable kinds as retryable", () => {
    for (const row of table) {
      const error = classifySesError(awsError(row.name, row.shape));
      expect(error.retryable, `${row.name} → ${row.kind}`).toBe(
        row.kind === "throttled" || row.kind === "transient",
      );
    }
  });

  it("NEVER discards the response body", () => {
    const body = JSON.stringify({
      __type: "BadRequestException",
      message: "Tenant name must match [A-Za-z0-9_-]{1,64}",
    });

    const error = classifySesError(
      awsError("BadRequestException", {
        status: 400,
        body,
        requestId: "req-42",
        message: "Bad request",
      }),
      "createTenant",
    );

    // Weeks later, from a log line alone, this must say WHAT AWS objected to.
    expect(error.detail).toContain("Tenant name must match");
    expect(error.httpStatusCode).toBe(400);
    expect(error.requestId).toBe("req-42");
    expect(error.message).toContain("createTenant");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("falls back to the AWS message when there is no body", () => {
    const error = classifySesError(
      awsError("NotFoundException", {
        status: 404,
        message: "Tenant env-abc not found",
      }),
    );
    expect(error.detail).toContain("Tenant env-abc not found");
  });

  it("passes an already-classified SesError straight through", () => {
    const original = new SesError("already classified", { kind: "not_found" });
    expect(classifySesError(original)).toBe(original);
  });
});

describe("AwsSesClient retry policy", () => {
  it("NEVER retries a 4xx — one call, no sleep", async () => {
    const { client, commands, delays } = harness(() => {
      throw awsError("BadRequestException", {
        status: 400,
        message: "invalid tenant name",
      });
    });

    const error = await client
      .createConfigurationSet({ configurationSetName: "cs-1" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SesError);
    expect((error as SesError).kind).toBe("invalid");
    // THE assertion. A 4xx will answer the same way forever; retrying it burns
    // the caller's budget and, on a send, risks a duplicate delivery.
    expect(commands).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("never retries ANY non-retryable kind", async () => {
    const permanent = [
      awsError("NotFoundException", { status: 404 }),
      awsError("AlreadyExistsException", { status: 400 }),
      awsError("AccountSuspendedException", { status: 400 }),
      awsError("MessageRejected", { status: 400 }),
      awsError("ConflictException", { status: 409 }),
    ];

    for (const failure of permanent) {
      const { client, commands } = harness(() => {
        throw failure;
      });
      await client
        .createConfigurationSet({ configurationSetName: "cs-1" })
        .catch(() => undefined);
      expect(commands, `${failure.name} was retried`).toHaveLength(1);
    }
  });

  it("retries a 5xx on bounded exponential backoff, then surfaces transient", async () => {
    const { client, commands, delays } = harness(() => {
      throw awsError("InternalServiceErrorException", {
        status: 500,
        fault: "server",
        message: "SES had a moment",
      });
    });

    const error = await client
      .createConfigurationSet({ configurationSetName: "cs-1" })
      .catch((thrown: unknown) => thrown);

    expect(commands).toHaveLength(SES_MAX_ATTEMPTS);
    expect(delays).toEqual([200, 400, 800, 1600]);
    expect(delays[0]).toBe(SES_BACKOFF_BASE_MS);
    expect((error as SesError).kind).toBe("transient");
    // Exhausted is still diagnosable: the last body rides along.
    expect((error as SesError).detail).toContain("SES had a moment");
    expect((error as SesError).message).toContain(
      `${SES_MAX_ATTEMPTS} attempts`,
    );
  });

  it("retries a throttle and returns the eventual success", async () => {
    const { client, commands, delays } = harness((_command, callIndex) => {
      if (callIndex < 3) {
        throw awsError("TooManyRequestsException", { status: 429 });
      }
      return { MessageId: "aws-message-1" };
    });

    const result = await client.sendEmail({
      tenantName: TENANT,
      message: {
        from: "hello@acme.test",
        to: ["buyer@example.test"],
        subject: "Welcome",
        html: "<p>hi</p>",
      },
    });

    expect(result.messageId).toBe("aws-message-1");
    expect(commands).toHaveLength(3);
    expect(delays).toEqual([200, 400]);
  });

  it("caps the backoff rather than sleeping forever", () => {
    expect(sesBackoffMs(1)).toBe(200);
    expect(sesBackoffMs(2)).toBe(400);
    expect(sesBackoffMs(20)).toBe(5_000);
  });
});

describe("AwsSesClient tenants", () => {
  it("returns the EXISTING tenant when AWS says it already exists", async () => {
    const { client, commands } = harness((command, callIndex) => {
      if (callIndex === 1)
        throw awsError("AlreadyExistsException", { status: 400 });
      expect(command).toBeInstanceOf(GetTenantCommand);
      return {
        Tenant: {
          TenantName: TENANT,
          TenantId: "t-1",
          TenantArn: `arn:aws:ses:us-east-1:1:tenant/${TENANT}`,
          SendingStatus: "ENABLED",
        },
      };
    });

    const tenant = await client.createTenant({ tenantName: TENANT });

    // Provisioning is resumable: a re-driven step reads through rather than
    // failing the whole pipeline on its own previous success.
    expect(tenant).toEqual({
      name: TENANT,
      id: "t-1",
      arn: `arn:aws:ses:us-east-1:1:tenant/${TENANT}`,
      sendingStatus: "ENABLED",
    });
    expect(commands[0]).toBeInstanceOf(CreateTenantCommand);
    expect(commands).toHaveLength(2);
  });

  it("reads a tenant back through the public verb", async () => {
    const arn = `arn:aws:ses:us-east-1:1:tenant/${TENANT}`;
    const { client, commands } = harness(() => ({
      Tenant: {
        TenantName: TENANT,
        TenantId: "t-1",
        TenantArn: arn,
        SendingStatus: "REINSTATED",
      },
    }));

    const tenant = await client.getTenant({ tenantName: TENANT });

    expect(commands[0]).toBeInstanceOf(GetTenantCommand);
    expect(tenant).toEqual({
      name: TENANT,
      id: "t-1",
      arn,
      sendingStatus: "REINSTATED",
    });
  });

  it("reports a tenant AWS does not return as a not-found", async () => {
    const { client } = harness(() => ({}));

    await expect(
      client.getTenant({ tenantName: TENANT }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("does not swallow a real create failure", async () => {
    const { client, commands } = harness(() => {
      throw awsError("BadRequestException", { status: 400 });
    });

    await expect(
      client.createTenant({ tenantName: "no spaces allowed" }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(commands).toHaveLength(1);
  });

  it("treats a repeated resource association as already done", async () => {
    const { client, commands } = harness((command) => {
      expect(command).toBeInstanceOf(CreateTenantResourceAssociationCommand);
      throw awsError("AlreadyExistsException", { status: 400 });
    });

    // Association is set membership: re-asserting it must not break a resumed
    // provision.
    await expect(
      client.associateResource({
        tenantName: TENANT,
        resourceArn: "arn:aws:ses:us-east-1:1:identity/acme.test",
      }),
    ).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
  });

  it("does not swallow a real association failure", async () => {
    const { client, commands } = harness(() => {
      throw awsError("NotFoundException", {
        status: 404,
        message: "Tenant does not exist",
      });
    });

    // ONLY `already_exists` is set membership; anything else must surface. A
    // catch that swallowed wider would let a provision "associate" a resource
    // with a missing tenant and defer the failure to the first customer send.
    await expect(
      client.associateResource({
        tenantName: TENANT,
        resourceArn: "arn:aws:ses:us-east-1:1:identity/acme.test",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(commands).toHaveLength(1);
  });
});

describe("AwsSesClient sending", () => {
  it("names the tenant and the configuration set on every send", async () => {
    const { client, commands } = harness(() => ({ MessageId: "aws-1" }));

    await client.sendEmail({
      tenantName: TENANT,
      configurationSetName: "cs-1",
      message: {
        from: "Acme <hello@acme.test>",
        to: ["buyer@example.test"],
        cc: ["cc@example.test"],
        bcc: ["bcc@example.test"],
        replyTo: ["reply@acme.test"],
        subject: "Welcome",
        html: "<p>hi</p>",
        text: "hi",
        headers: { "List-Unsubscribe": "<https://acme.test/u>" },
        tags: [{ name: "template", value: "welcome" }],
      },
    });

    const command = commands[0];
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command?.input).toMatchObject({
      // Without TenantName the send lands on the ACCOUNT and every isolation
      // guarantee in DECISIONS §3.2 evaporates silently.
      TenantName: TENANT,
      ConfigurationSetName: "cs-1",
      FromEmailAddress: "Acme <hello@acme.test>",
      Destination: {
        ToAddresses: ["buyer@example.test"],
        CcAddresses: ["cc@example.test"],
        BccAddresses: ["bcc@example.test"],
      },
      ReplyToAddresses: ["reply@acme.test"],
      Content: {
        Simple: {
          Subject: { Data: "Welcome", Charset: "UTF-8" },
          Body: {
            Html: { Data: "<p>hi</p>", Charset: "UTF-8" },
            Text: { Data: "hi", Charset: "UTF-8" },
          },
          Headers: [
            { Name: "List-Unsubscribe", Value: "<https://acme.test/u>" },
          ],
        },
      },
      EmailTags: [{ Name: "template", Value: "welcome" }],
    });
  });

  it("sends a batch on a BOUNDED pool, not one round trip at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { client, commands } = harness(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Suspend for a microtask turn, so overlap is observable without a
      // timer and the assertion stays deterministic.
      await Promise.resolve();
      inFlight -= 1;
      return { MessageId: "aws" };
    });

    const messages = Array.from({ length: 20 }, (_unused, index) => ({
      from: "hello@acme.test",
      to: [`buyer-${index}@example.test`],
      subject: "Welcome",
      html: "<p>hi</p>",
    }));
    await client.sendBatch({ tenantName: TENANT, messages });

    expect(commands).toHaveLength(20);
    // Bounded ABOVE, so a broadcast cannot open twenty connections to SES at
    // once and earn a throttle...
    expect(maxInFlight).toBe(SES_BATCH_CONCURRENCY);
    // ...and bounded BELOW, because fully serial makes a hundred-message batch
    // a hundred sequential round trips, which is the latency PRD 03 inherits.
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("keeps results in INPUT order even when sends complete out of order", async () => {
    const settle: (() => void)[] = [];
    const { client } = harness(
      (_command, callIndex) =>
        new Promise((resolve) => {
          settle.push(() => resolve({ MessageId: `aws-${callIndex}` }));
        }),
    );

    const pending = client.sendBatch({
      tenantName: TENANT,
      messages: [1, 2, 3].map((n) => ({
        from: "hello@acme.test",
        to: [`buyer-${n}@example.test`],
        subject: `Message ${n}`,
        html: `<p>${n}</p>`,
      })),
    });

    // All three are in flight (3 < the pool), so completion order is ours to
    // choose. Finish them BACKWARDS — draining the microtask queue after each,
    // which is what makes the completions genuinely interleave.
    //
    // Resolving all three in one synchronous burst does NOT work, and the way
    // it fails is instructive: the awaits have not attached yet, so the
    // continuations run in REGISTRATION order and the batch comes back in
    // input order no matter how it was implemented. That version of this test
    // passed against a deliberately broken append-on-completion build.
    expect(settle).toHaveLength(3);
    for (const resolve of [...settle].reverse()) {
      resolve();
      await drainMicrotasks();
    }

    // PRD 03 pairs result[i] with message[i]. An implementation that pushed
    // results as they landed would answer aws-3, aws-2, aws-1 here — and would
    // mis-attribute every delivery in the batch.
    expect((await pending).results).toEqual([
      { status: "sent", messageId: "aws-1" },
      { status: "sent", messageId: "aws-2" },
      { status: "sent", messageId: "aws-3" },
    ]);
  });

  it("fans a batch out to one send per message and keeps per-entry failures", async () => {
    const { client, commands } = harness((_command, callIndex) => {
      if (callIndex === 2) {
        throw awsError("MessageRejected", {
          status: 400,
          message: "Email address is not verified",
        });
      }
      return { MessageId: `aws-${callIndex}` };
    });

    const result = await client.sendBatch({
      tenantName: TENANT,
      messages: [1, 2, 3].map((n) => ({
        from: "hello@acme.test",
        to: [`buyer-${n}@example.test`],
        subject: `Message ${n}`,
        html: `<p>${n}</p>`,
      })),
    });

    // SES's own bulk API is TEMPLATE-only, so per-recipient HTML cannot ride
    // it; the fan-out is the honest implementation, and one bad address must
    // not cost the other two their delivery.
    expect(commands).toHaveLength(3);
    expect(result.results).toEqual([
      { status: "sent", messageId: "aws-1" },
      {
        status: "failed",
        kind: "invalid",
        message: expect.stringContaining("MessageRejected"),
        detail: expect.stringContaining("not verified"),
      },
      { status: "sent", messageId: "aws-3" },
    ]);
  });
});

describe("AwsSesClient attachments", () => {
  /** "%PDF-1.7" — real file magic, so a corrupted mapping is visibly wrong. */
  const PDF_BYTES = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
  ]);

  interface SesAttachmentWire {
    FileName?: string;
    RawContent?: unknown;
    ContentType?: string;
    ContentDisposition?: string;
    ContentId?: string;
    ContentTransferEncoding?: string;
  }

  /** The `Content.Simple` block of a captured command, for absence checks. */
  function simpleOf(
    command: SesCommandLike | undefined,
  ): Record<string, unknown> {
    const input = command?.input as {
      Content?: { Simple?: Record<string, unknown> };
    };
    const simple = input?.Content?.Simple;
    expect(simple).toBeDefined();
    return simple as Record<string, unknown>;
  }

  function attachmentsOf(
    command: SesCommandLike | undefined,
  ): SesAttachmentWire[] {
    return simpleOf(command).Attachments as SesAttachmentWire[];
  }

  async function sendWith(
    attachments: SesAttachment[] | undefined,
  ): Promise<SesCommandLike[]> {
    const { client, commands } = harness(() => ({ MessageId: "aws-1" }));
    await client.sendEmail({
      tenantName: TENANT,
      message: {
        from: "hello@acme.test",
        to: ["buyer@example.test"],
        subject: "Invoice",
        html: "<p>attached</p>",
        ...(attachments ? { attachments } : {}),
      },
    });
    return commands;
  }

  it("emits NO Attachments key at all when a message has none", async () => {
    // The most important assertion in the feature: every send that exists
    // today takes this path, and the command it emits must be BYTE-IDENTICAL
    // to what it was before attachments existed — no `Attachments` key, not
    // an empty array.
    const absent = await sendWith(undefined);
    expect(simpleOf(absent[0])).not.toHaveProperty("Attachments");

    // An EMPTY array is the same statement as no field: nobody means
    // `Attachments: []`, and it is a wire shape nothing has ever tested.
    const empty = await sendWith([]);
    expect(simpleOf(empty[0])).not.toHaveProperty("Attachments");
  });

  it("maps raw bytes onto Simple.Attachments as FileName + RawContent", async () => {
    const commands = await sendWith([
      {
        filename: "invoice.pdf",
        content: PDF_BYTES,
        contentType: "application/pdf",
      },
    ]);

    const attachments = attachmentsOf(commands[0]);
    expect(attachments).toHaveLength(1);
    const attachment = attachments[0];
    expect(attachment?.FileName).toBe("invoice.pdf");
    expect(attachment?.ContentType).toBe("application/pdf");
    expect(attachment?.RawContent).toBeInstanceOf(Uint8Array);
    expect(Array.from(attachment?.RawContent as Uint8Array)).toEqual(
      Array.from(PDF_BYTES),
    );
    // Neither optional field was supplied, so neither key may appear —
    // an invented default disposition would be the seam guessing.
    expect(attachment).not.toHaveProperty("ContentDisposition");
    expect(attachment).not.toHaveProperty("ContentId");
  });

  it("decodes { base64 } content to the SAME RawContent bytes as raw bytes", async () => {
    // THE double-encoding catch. The SDK base64-encodes `RawContent` itself,
    // so if the base64 STRING ever passed through as RawContent it would be
    // encoded AGAIN and the recipient would get a corrupt file from a send
    // that reported success — nothing errors at any layer. The only proof
    // against it is that both content forms land as the identical raw bytes.
    const [rawForm] = await sendWith([
      { filename: "invoice.pdf", content: PDF_BYTES },
    ]);
    const [base64Form] = await sendWith([
      {
        filename: "invoice.pdf",
        content: { base64: Buffer.from(PDF_BYTES).toString("base64") },
      },
    ]);

    const fromRaw = attachmentsOf(rawForm)[0]?.RawContent as Uint8Array;
    const fromBase64 = attachmentsOf(base64Form)[0]?.RawContent as Uint8Array;
    expect(fromBase64).toBeInstanceOf(Uint8Array);
    expect(typeof fromBase64).not.toBe("string");
    expect(Array.from(fromBase64)).toEqual(Array.from(fromRaw));
    expect(Array.from(fromBase64)).toEqual(Array.from(PDF_BYTES));
  });

  it("maps disposition onto SES's enum and carries the content id", async () => {
    const commands = await sendWith([
      {
        filename: "logo.png",
        content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        contentType: "image/png",
        disposition: "inline",
        contentId: "logo@acme",
      },
      {
        filename: "terms.pdf",
        content: PDF_BYTES,
        disposition: "attachment",
      },
    ]);

    const attachments = attachmentsOf(commands[0]);
    expect(attachments[0]?.ContentDisposition).toBe("INLINE");
    expect(attachments[0]?.ContentId).toBe("logo@acme");
    expect(attachments[1]?.ContentDisposition).toBe("ATTACHMENT");
    expect(attachments[1]).not.toHaveProperty("ContentId");
  });

  it("omits ContentType entirely when absent — never guessed from the filename", async () => {
    const commands = await sendWith([
      { filename: "export.csv", content: new Uint8Array([0x61, 0x2c, 0x62]) },
    ]);
    // SES defaults; a guess from ".csv" here would be this seam inventing a
    // fact the caller never stated.
    expect(attachmentsOf(commands[0])[0]).not.toHaveProperty("ContentType");
  });

  it("NEVER sets ContentTransferEncoding, on either content form", async () => {
    // The SDK owns the transfer encoding of `RawContent`. Declaring one it
    // did not apply is a way to be wrong about our own bytes.
    const commands = await sendWith([
      { filename: "invoice.pdf", content: PDF_BYTES },
      {
        filename: "receipt.pdf",
        content: { base64: Buffer.from(PDF_BYTES).toString("base64") },
      },
    ]);
    for (const attachment of attachmentsOf(commands[0])) {
      expect(attachment).not.toHaveProperty("ContentTransferEncoding");
    }
  });

  it("sendBatch carries attachments through to each per-message send", async () => {
    // No batch-specific code exists, by design: sendBatch is a bounded pool
    // over sendEmail, so attachments flow through the moment sendEmail
    // carries them. This asserts that fact instead of building anything.
    const { client, commands } = harness(() => ({ MessageId: "aws" }));
    await client.sendBatch({
      tenantName: TENANT,
      messages: [
        {
          from: "hello@acme.test",
          to: ["one@example.test"],
          subject: "Invoice 1",
          html: "<p>1</p>",
          attachments: [{ filename: "one.pdf", content: PDF_BYTES }],
        },
        {
          from: "hello@acme.test",
          to: ["two@example.test"],
          subject: "No files",
          html: "<p>2</p>",
        },
      ],
    });

    expect(commands).toHaveLength(2);
    // The pool answers in input order here, but pair by recipient anyway —
    // the batch contract is positional on RESULTS, not on wire order.
    const byRecipient = new Map(
      commands.map((command) => {
        const input = command.input as {
          Destination: { ToAddresses: string[] };
        };
        return [input.Destination.ToAddresses[0], command] as const;
      }),
    );

    const withFile = attachmentsOf(byRecipient.get("one@example.test"));
    expect(withFile).toHaveLength(1);
    expect(withFile[0]?.FileName).toBe("one.pdf");
    expect(Array.from(withFile[0]?.RawContent as Uint8Array)).toEqual(
      Array.from(PDF_BYTES),
    );
    // And the file-less message in the SAME batch stays byte-identical to
    // today's wire — attachments on one entry must not leak onto another.
    expect(simpleOf(byRecipient.get("two@example.test"))).not.toHaveProperty(
      "Attachments",
    );
  });
});

describe("AwsSesClient configuration sets, identities and reputation", () => {
  it("UPSERTS an event destination that already exists", async () => {
    const { client, commands } = harness((command, callIndex) => {
      if (callIndex === 1) {
        expect(command).toBeInstanceOf(
          CreateConfigurationSetEventDestinationCommand,
        );
        throw awsError("AlreadyExistsException", { status: 400 });
      }
      return {};
    });

    await client.putEventDestination({
      configurationSetName: "cs-1",
      eventDestinationName: "hogsend-sns",
      snsTopicArn: "arn:aws:sns:us-east-1:1:hogsend",
      eventTypes: ["BOUNCE", "COMPLAINT", "DELIVERY"],
    });

    // A verb called `put` has to be a put. PRD 05 re-runs this on every
    // provision resume.
    expect(commands[1]).toBeInstanceOf(
      UpdateConfigurationSetEventDestinationCommand,
    );
    expect(commands[1]?.input).toMatchObject({
      ConfigurationSetName: "cs-1",
      EventDestinationName: "hogsend-sns",
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: ["BOUNCE", "COMPLAINT", "DELIVERY"],
        SnsDestination: { TopicArn: "arn:aws:sns:us-east-1:1:hogsend" },
      },
    });
  });

  it("puts the suppression scope through the TENANT operation", async () => {
    const { client, commands } = harness(() => ({}));

    await client.putSuppressionScope({
      tenantName: TENANT,
      scope: "TENANT",
      reasons: ["BOUNCE", "COMPLAINT"],
    });

    // `PutTenantSuppressionAttributes`, NOT the similarly-named
    // `PutConfigurationSetSuppressionOptions`. The config-set call takes no
    // tenant and cannot set tenant scope, so wiring it would leave every
    // tenant on the ACCOUNT suppression list: one customer's hard bounce
    // suppressing that address for all of them, with no error to notice.
    expect(commands[0]).toBeInstanceOf(PutTenantSuppressionAttributesCommand);
    expect(commands[0]?.input).toEqual({
      TenantName: TENANT,
      SuppressionScope: "TENANT",
      SuppressedReasons: ["BOUNCE", "COMPLAINT"],
    });
  });

  it("creates a BYODKIM identity with our own 2048-bit key", async () => {
    const { client, commands } = harness(() => ({
      IdentityType: "DOMAIN",
      VerifiedForSendingStatus: false,
      DkimAttributes: {
        Status: "PENDING",
        SigningEnabled: true,
        SigningAttributesOrigin: "EXTERNAL",
        Tokens: [],
      },
    }));

    const identity = await client.createIdentity({
      domain: "acme.test",
      configurationSetName: "cs-1",
      dkim: { selector: "hogsend", privateKey: "PRIVATE-KEY" },
    });

    expect(commands[0]).toBeInstanceOf(CreateEmailIdentityCommand);
    expect(commands[0]?.input).toMatchObject({
      EmailIdentity: "acme.test",
      ConfigurationSetName: "cs-1",
      DkimSigningAttributes: {
        DomainSigningSelector: "hogsend",
        DomainSigningPrivateKey: "PRIVATE-KEY",
        // BYODKIM verifies a domain with ONE TXT record (DECISIONS §2).
        DomainSigningAttributesOrigin: "EXTERNAL",
      },
    });
    // `NextSigningKeyLength` MUST NOT be sent with BYODKIM. This assertion is
    // inverted from what it was, and the story is the point: the test used to
    // require the field, so implementation, Fake, contract AND test all agreed
    // with each other and all four were wrong together. AWS rejects the
    // combination outright ("NextSigningKeyLength cannot be used together with
    // DomainSigningSelector and DomainSigningPrivateKey"), so `createIdentity`
    // failed 100% of the time and no customer domain could ever have verified.
    // A green suite certified that outage until the first live run.
    expect(
      (commands[0]?.input as { DkimSigningAttributes?: object })
        ?.DkimSigningAttributes,
    ).not.toHaveProperty("NextSigningKeyLength");
    expect(identity).toMatchObject({
      identity: "acme.test",
      verifiedForSending: false,
      verificationStatus: "PENDING",
      dkim: { status: "PENDING", origin: "EXTERNAL" },
    });
  });

  it("reads an identity's verification and MAIL FROM state", async () => {
    const { client, commands } = harness(() => ({
      VerifiedForSendingStatus: true,
      VerificationStatus: "SUCCESS",
      DkimAttributes: {
        Status: "SUCCESS",
        SigningEnabled: true,
        SigningAttributesOrigin: "EXTERNAL",
        Tokens: ["token-1"],
      },
      MailFromAttributes: {
        MailFromDomain: "send.acme.test",
        MailFromDomainStatus: "SUCCESS",
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      },
      ConfigurationSetName: "cs-1",
    }));

    const identity = await client.getIdentity({ identity: "acme.test" });

    expect(commands[0]).toBeInstanceOf(GetEmailIdentityCommand);
    expect(identity).toEqual({
      identity: "acme.test",
      verifiedForSending: true,
      verificationStatus: "SUCCESS",
      dkim: {
        status: "SUCCESS",
        signingEnabled: true,
        origin: "EXTERNAL",
        tokens: ["token-1"],
      },
      mailFrom: {
        domain: "send.acme.test",
        status: "SUCCESS",
        behaviorOnMxFailure: "USE_DEFAULT_VALUE",
      },
      configurationSetName: "cs-1",
    });
  });

  it("sets a custom MAIL FROM", async () => {
    const { client, commands } = harness(() => ({}));

    await client.setMailFrom({
      identity: "acme.test",
      mailFromDomain: "send.acme.test",
    });

    expect(commands[0]).toBeInstanceOf(
      PutEmailIdentityMailFromAttributesCommand,
    );
    expect(commands[0]?.input).toMatchObject({
      EmailIdentity: "acme.test",
      MailFromDomain: "send.acme.test",
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    });
  });

  it("resolves the tenant ARN before writing a reputation decision", async () => {
    const arn = `arn:aws:ses:us-east-1:1:tenant/${TENANT}`;
    const { client, commands } = harness((command) => {
      if (command instanceof GetTenantCommand) {
        return {
          Tenant: {
            TenantName: TENANT,
            TenantId: "t-1",
            TenantArn: arn,
            SendingStatus: "ENABLED",
          },
        };
      }
      return {};
    });

    await client.setReputationPolicy({ tenantName: TENANT, policy: "STRICT" });
    await client.setTenantSendingStatus({
      tenantName: TENANT,
      status: "DISABLED",
    });

    expect(commands[1]).toBeInstanceOf(UpdateReputationEntityPolicyCommand);
    expect(commands[1]?.input).toMatchObject({
      ReputationEntityType: "RESOURCE",
      // The tenant ARN, never the tenant NAME — which is the whole reason
      // `getTenant` has to exist.
      ReputationEntityReference: arn,
      // And the policy is itself an AWS-OWNED ARN, not the bare word. Sending
      // "STRICT" here is a validation error at best and a silently ignored
      // policy at worst.
      ReputationEntityPolicy:
        "arn:aws:ses:us-east-1:aws:reputation-policy/strict",
    });
    expect(commands[3]).toBeInstanceOf(
      UpdateReputationEntityCustomerManagedStatusCommand,
    );
    expect(commands[3]?.input).toMatchObject({
      ReputationEntityType: "RESOURCE",
      ReputationEntityReference: arn,
      SendingStatus: "DISABLED",
    });
  });

  it("builds the policy ARN in the CLIENT's region, not the tenant ARN's", async () => {
    const { client, commands } = harness(
      (command) =>
        command instanceof GetTenantCommand
          ? // A deliberately mismatched ARN: a tenant handle copied between
            // regions must not be the thing that decides where the policy
            // lives. The client's own region is the pinned truth (DECISIONS
            // §3.3), and it is the only region whose credentials we hold.
            { Tenant: { TenantArn: "arn:aws:ses:us-east-1:1:tenant/t" } }
          : {},
      { region: "eu" },
    );

    await client.setReputationPolicy({ tenantName: TENANT, policy: "NONE" });

    expect(commands[1]?.input).toMatchObject({
      ReputationEntityPolicy:
        "arn:aws:ses:eu-west-1:aws:reputation-policy/none",
    });
  });

  it("reads the reputation entity a reconciler acts on", async () => {
    const arn = `arn:aws:ses:us-east-1:1:tenant/${TENANT}`;
    const { client, commands } = harness((command) =>
      command instanceof GetTenantCommand
        ? { Tenant: { TenantName: TENANT, TenantArn: arn } }
        : {
            ReputationEntity: {
              ReputationEntityReference: arn,
              ReputationEntityType: "RESOURCE",
              ReputationManagementPolicy:
                "arn:aws:ses:us-east-1:aws:reputation-policy/strict",
              SendingStatusAggregate: "DISABLED",
              CustomerManagedStatus: { Status: "ENABLED" },
              AwsSesManagedStatus: {
                Status: "DISABLED",
                Cause: "Bounce rate above 10%",
                LastUpdatedTimestamp: new Date("2026-08-10T00:00:00.000Z"),
              },
              ReputationImpact: "HIGH",
            },
          },
    );

    const entity = await client.getReputationEntity({ tenantName: TENANT });

    // Addressed by NAME like every other reputation verb, so PRD 08 never has
    // to carry ARNs around; the ARN lookup happens here.
    expect(commands[0]).toBeInstanceOf(GetTenantCommand);
    expect(commands[1]).toBeInstanceOf(GetReputationEntityCommand);
    expect(commands[1]?.input).toEqual({
      ReputationEntityType: "RESOURCE",
      ReputationEntityReference: arn,
    });
    expect(entity).toEqual({
      reference: arn,
      // The AGGREGATE is what a reconciler mirrors: a missed EventBridge pause
      // event otherwise leaves the relay reading "active" and failing OPEN.
      sendingStatus: "DISABLED",
      // The policy ARN maps BACK to our own vocabulary, so a write and a read
      // round-trip to the same value.
      policy: "STRICT",
      policyArn: "arn:aws:ses:us-east-1:aws:reputation-policy/strict",
      customerManagedStatus: { status: "ENABLED" },
      awsSesManagedStatus: {
        status: "DISABLED",
        cause: "Bounce rate above 10%",
        lastUpdatedAt: "2026-08-10T00:00:00.000Z",
      },
      impact: "HIGH",
    });
  });

  it("reports a reputation entity AWS does not return as a not-found", async () => {
    const { client } = harness(() => ({}));

    await expect(
      client.getReputationEntity({
        tenantName: TENANT,
        tenantArn: "arn:aws:ses:us-east-1:1:tenant/x",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("skips the ARN lookup when the caller already holds the ARN", async () => {
    const arn = `arn:aws:ses:us-east-1:1:tenant/${TENANT}`;
    const { client, commands } = harness(() => ({
      ReputationEntity: { ReputationEntityReference: arn },
    }));

    await client.getReputationEntity({ tenantName: TENANT, tenantArn: arn });

    // PRD 06 persists the ARN at provision time, and PRD 08 sweeps every
    // tenant: paying a second rate-limited call per tenant to re-learn
    // something we already stored would double the sweep for nothing.
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetReputationEntityCommand);
  });

  it("lists recommendations through the filter keys AWS understands", async () => {
    const { client, commands } = harness(() => ({
      Recommendations: [
        {
          ResourceArn: "arn:aws:ses:us-east-1:1:identity/acme.test",
          Type: "DMARC",
          Status: "OPEN",
          Impact: "HIGH",
          Description: "Publish a DMARC record",
          CreatedTimestamp: new Date("2026-08-10T00:00:00.000Z"),
        },
      ],
      NextToken: "next",
    }));

    const page = await client.listRecommendations({
      resourceArn: "arn:aws:ses:us-east-1:1:identity/acme.test",
      status: "OPEN",
    });

    expect(commands[0]?.input).toMatchObject({
      Filter: {
        RESOURCE_ARN: "arn:aws:ses:us-east-1:1:identity/acme.test",
        STATUS: "OPEN",
      },
    });
    expect(page).toEqual({
      recommendations: [
        {
          resourceArn: "arn:aws:ses:us-east-1:1:identity/acme.test",
          type: "DMARC",
          status: "OPEN",
          impact: "HIGH",
          description: "Publish a DMARC record",
          createdAt: "2026-08-10T00:00:00.000Z",
        },
      ],
      nextToken: "next",
    });
  });
});
