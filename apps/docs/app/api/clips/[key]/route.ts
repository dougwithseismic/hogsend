import { AwsClient } from "aws4fetch";

/**
 * Streams marketing clips out of the private Railway bucket (Tigris,
 * S3-compatible) with a SigV4-signed fetch. The bucket has no public
 * access, so this route is the public face; responses are immutable and
 * cached hard at the Cloudflare edge, so the bucket only sees misses.
 *
 * Env (Railway service variables / .env.local):
 *   CLIPS_S3_HOST              https://<bucket>.t3.storageapi.dev
 *   CLIPS_S3_ACCESS_KEY_ID
 *   CLIPS_S3_SECRET_ACCESS_KEY
 */

const VALID_KEY = /^[a-z0-9][a-z0-9-]*\.(mp4|jpg)$/;

const PASSTHROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await params;
  const host = process.env.CLIPS_S3_HOST;
  const accessKeyId = process.env.CLIPS_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CLIPS_S3_SECRET_ACCESS_KEY;
  if (!(host && accessKeyId && secretAccessKey) || !VALID_KEY.test(key)) {
    return new Response("Not found", { status: 404 });
  }

  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
  });

  // Forward Range so <video> seeking gets 206s instead of full bodies.
  const range = req.headers.get("range");
  const upstream = await aws.fetch(`${host}/${key}`, {
    headers: range ? { range } : undefined,
  });

  if (!upstream.ok && upstream.status !== 206) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(upstream.body, { status: upstream.status, headers });
}
