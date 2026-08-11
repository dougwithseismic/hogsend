import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { resolveSesRegion } from "../ses/contract";
import { readSesCredentials } from "../ses/index";
import type { SubstrateRegion } from "../substrate/types";

/**
 * THE ONE PLACE raw mail is read out of S3, and the only place a size limit
 * could be forgotten.
 *
 * SES stores a received message of up to 40 MB
 * (`SES_INBOUND_MAX_S3_MESSAGE_BYTES`), and every byte of it was written by
 * whoever sent it. Pulling an unbounded object into a request handler is a
 * memory bill an anonymous sender gets to write, so the read is bounded twice
 * over and the two bounds do different jobs:
 *
 *  1. **HEAD first.** The object's length is learned WITHOUT reading it, so an
 *     oversized message is refused having allocated nothing. That is the
 *     property PRD 16 asks for in so many words: "do not pull an unbounded
 *     object into memory without a limit, and refuse over it rather than
 *     falling over". The transport seam below exists so a test can PROVE the
 *     body was never requested, rather than trusting that it was not.
 *  2. **A ranged GET second.** `Range: bytes=0-<cap>` bounds the allocation
 *     even if the HEAD was wrong or the object changed between the two calls,
 *     and a body that comes back over the cap is refused rather than parsed:
 *     a truncated MIME parse is a worse thing to hold than none.
 *
 * A refusal is never a drop. The caller records the message, keeps the S3
 * reference, and simply emits no event - the raw mail is still in the bucket
 * and still forwardable (PRD 16 task 6, which streams rather than buffers).
 */

/**
 * How much of a received message this process will hold in memory.
 *
 * 10 MiB. Sized from what real replies look like rather than from SES's
 * ceiling: a typed answer is kilobytes, a reply carrying a phone photo is a few
 * megabytes, and the long tail above that is a forwarded thread with a deck
 * attached - which we forward and do not need to read. The gap between this and
 * SES's 40 MB is deliberate headroom we decline to allocate on demand for an
 * anonymous sender.
 */
export const MAX_INBOUND_OBJECT_BYTES = 10 * 1024 * 1024;

export interface InboundObjectRef {
  bucket: string;
  key: string;
  /** The tenant's data-residency region; the bucket may be elsewhere. */
  region: SubstrateRegion;
}

export interface InboundObject {
  /** Raw MIME bytes, never longer than the requested cap. */
  body: Uint8Array;
  size: number;
}

/** The read seam. Injected in every test; nothing in CI reaches S3. */
export type InboundObjectFetcher = (
  input: InboundObjectRef & { maxBytes: number },
) => Promise<InboundObject>;

/**
 * S3, as this module needs it: two verbs over plain values.
 *
 * The house rule the SES seams already keep - no SDK command, no `$metadata`,
 * no AWS enum object crosses the boundary - applied here so the HEAD-before-GET
 * ordering is testable without an AWS mock. A fake transport that records which
 * verb was called is how "refused without reading the body" becomes an
 * assertion instead of a comment.
 */
export interface InboundS3Transport {
  head(ref: { bucket: string; key: string }): Promise<{ size?: number }>;
  get(ref: {
    bucket: string;
    key: string;
    /** An HTTP byte range, inclusive on both ends. */
    range: string;
  }): Promise<{ body: Uint8Array }>;
}

/** The stored message is bigger than we will read. NOT a delivery failure. */
export class InboundObjectTooLargeError extends Error {
  readonly code = "inbound_object_too_large";

  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(
      `the received message is ${size} bytes, above the ${maxBytes}-byte parse ` +
        "limit; it is stored and referenced but not parsed",
    );
    this.name = "InboundObjectTooLargeError";
  }
}

/** The object could not be read at all. Transient until proven otherwise. */
export class InboundObjectUnavailableError extends Error {
  readonly code = "inbound_object_unavailable";

  constructor(
    readonly ref: { bucket: string; key: string },
    readonly cause: unknown,
  ) {
    super(
      `could not read s3://${ref.bucket}/${ref.key}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "InboundObjectUnavailableError";
  }
}

/**
 * The bounded read, over any transport.
 *
 * Throws {@link InboundObjectTooLargeError} for an object above the cap - and
 * throws it from the HEAD, before a single byte of body has been requested.
 */
export function createInboundObjectFetcher(
  transport: (region: SubstrateRegion) => InboundS3Transport,
): InboundObjectFetcher {
  return async (input) => {
    const s3 = transport(input.region);
    const ref = { bucket: input.bucket, key: input.key };

    let size: number | undefined;
    try {
      size = (await s3.head(ref)).size;
    } catch (cause) {
      throw new InboundObjectUnavailableError(ref, cause);
    }

    // REFUSED HAVING READ NOTHING. The body was never requested.
    if (size !== undefined && size > input.maxBytes) {
      throw new InboundObjectTooLargeError(size, input.maxBytes);
    }

    let body: Uint8Array;
    try {
      const object = await s3.get({
        ...ref,
        // Inclusive on both ends, so this asks for `maxBytes + 1` bytes: one
        // more than we will accept, which is what makes "the object was bigger
        // than HEAD said" detectable rather than silently truncated.
        range: `bytes=0-${input.maxBytes}`,
      });
      body = object.body;
    } catch (cause) {
      throw new InboundObjectUnavailableError(ref, cause);
    }

    if (body.byteLength > input.maxBytes) {
      throw new InboundObjectTooLargeError(body.byteLength, input.maxBytes);
    }

    return { body, size: size ?? body.byteLength };
  };
}

/**
 * One S3 client per SES region.
 *
 * The BUCKET is shared across regions (AWS: "with the exception of Amazon S3
 * buckets, all of the AWS resources that you use for receiving email with SES
 * have to be in the same AWS Region as the SES endpoint"), but the client is
 * still built per region so a signed request is signed for the region the
 * notification came from rather than a process-wide guess.
 */
const clients = new Map<SubstrateRegion, S3Client>();

function clientFor(region: SubstrateRegion): S3Client {
  const cached = clients.get(region);
  if (cached) return cached;

  // The SAME gate the SES seams use, so a half-configured account fails once
  // and loudly instead of reading mail with one credential and provisioning
  // with another.
  const credentials = readSesCredentials();
  if (!credentials) {
    throw new Error(
      "reading a received message needs CLOUD_AWS_ACCESS_KEY_ID and " +
        "CLOUD_AWS_SECRET_ACCESS_KEY; a control plane with no AWS account " +
        "cannot fetch inbound mail from S3",
    );
  }
  const client = new S3Client({
    region: resolveSesRegion(region),
    credentials,
  });
  clients.set(region, client);
  return client;
}

/** Tests only. Production holds clients for the lifetime of the process. */
export function resetInboundObjectClients(): void {
  clients.clear();
}

/** The real transport: two AWS commands, nothing else crossing the boundary. */
export function awsInboundS3Transport(
  region: SubstrateRegion,
): InboundS3Transport {
  const client = clientFor(region);
  return {
    async head(ref) {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: ref.bucket, Key: ref.key }),
      );
      return { size: head.ContentLength };
    },
    async get(ref) {
      const object = await client.send(
        new GetObjectCommand({
          Bucket: ref.bucket,
          Key: ref.key,
          Range: ref.range,
        }),
      );
      if (!object.Body) throw new Error("the object had no body");
      return { body: await object.Body.transformToByteArray() };
    },
  };
}

/** The bound fetcher every caller uses in production. */
export const fetchInboundObject: InboundObjectFetcher =
  createInboundObjectFetcher(awsInboundS3Transport);
