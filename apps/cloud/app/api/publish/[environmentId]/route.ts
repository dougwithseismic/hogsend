import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  buildArtifactKey,
  isUuid,
  removeArtifact,
  writeArtifact,
} from "@/src/lib/artifacts";
import { buildService } from "@/src/services/builds";
import { BuildInFlightError } from "@/src/services/errors";
import { publishTokenService } from "@/src/services/publish-tokens";

/**
 * `POST /api/publish/:environmentId` — the publish intake (PRD 08 task 2).
 *
 * It STORES and QUEUES; it does not build. The tarball goes to
 * `CLOUD_ARTIFACTS_DIR`, a `queued` build row goes to the database, and the
 * answer is 202. Task 3's worker is what walks the record through the machine.
 *
 * The rules, in the order they are applied — the order IS the security posture:
 *
 *  1. **Authenticate before reading a byte.** `proxy.ts` excludes `/api` from
 *     the session matcher, so this handler authenticates itself: a bearer
 *     publish token, checked against its sha256. An upload with no valid token
 *     is refused before the body is touched, so an anonymous caller cannot make
 *     this process buffer 64MB.
 *  2. **The token names its own environment.** A token valid for environment A
 *     posting to environment B is 403, not 401: it is a real credential used
 *     against a target it does not own, and saying so is not a leak — the
 *     holder already knows their own environment id.
 *  3. **The size cap is enforced TWICE.** `Content-Length` is a hint, checked
 *     first so an honest oversize upload is refused without reading it; the
 *     body is then piped through a counting stream that ERRORS past the cap, so
 *     a lying (or absent) `Content-Length` cannot buy a byte more than the cap.
 *  4. **A rejected upload leaves nothing.** Every refusal above happens before
 *     any write. The one refusal that can happen after the file is on disk —
 *     the single-flight index rejecting a second concurrent build — deletes the
 *     file it wrote.
 */

/** Uploads are capped at 64MB of tarball (PRD 08 task 2). */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

/**
 * The cap on the whole multipart body: the tarball plus the manifest part and
 * the MIME framing around both. Slack rather than exactness, because the
 * stream-level cap cannot see part boundaries — the tarball's own size is
 * checked precisely once the parts are parsed.
 */
export const MAX_BODY_BYTES = MAX_TARBALL_BYTES + 64 * 1024;

/** A manifest is metadata. Anything larger is not one. */
const MAX_MANIFEST_CHARS = 16 * 1024;

/** gzip's magic number. A `.tar.gz` starts with it; nothing else here does. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/**
 * The upload manifest.
 *
 * `engineVersion` is the only REQUIRED field — it is what the build pins and
 * what lands on the stack at success. Unknown keys are KEPT (the CLI's manifest
 * grows: entry points, env key names) so the stored row is what was actually
 * uploaded rather than this file's idea of it in the week it was written.
 */
const manifestSchema = z.looseObject({
  engineVersion: z.string().min(1).max(64),
  appName: z.string().min(1).max(128).optional(),
  nodeVersion: z.string().min(1).max(32).optional(),
});

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

/** Marker the limiting stream fails with, recognised below as a 413. */
const OVERSIZE = "hogsend:body-too-large";

// The handler writes to disk and to the database; nothing about it may be
// cached or prerendered.
export const dynamic = "force-dynamic";

function fail(status: number, error: string, message: string): Response {
  return Response.json(
    { error, message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** A pass-through that errors the stream the moment `cap` is exceeded. */
function limitBytes(cap: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > cap) {
        controller.error(new Error(OVERSIZE));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

function isOversize(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof Error && current.message === OVERSIZE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The declared body size, when the client declared one it can be believed. */
function declaredLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ environmentId: string }> },
): Promise<Response> {
  const { environmentId } = await context.params;

  const match = BEARER_PATTERN.exec(request.headers.get("authorization") ?? "");
  const token = match?.[1];
  if (!token) {
    return fail(
      401,
      "missing_token",
      "Send the environment's publish token as `Authorization: Bearer hspub_…`.",
    );
  }

  const verified = await publishTokenService.verify({ token });
  if (!verified.found) {
    return fail(
      401,
      "invalid_token",
      "That publish token is not valid. Rotate the environment's token and try again.",
    );
  }
  if (!isUuid(environmentId) || verified.environmentId !== environmentId) {
    return fail(
      403,
      "forbidden_environment",
      "That publish token belongs to a different environment.",
    );
  }

  const declared = declaredLength(request.headers);
  if (declared !== null && declared > MAX_BODY_BYTES) {
    return fail(
      413,
      "payload_too_large",
      `The upload is larger than the ${MAX_TARBALL_BYTES / (1024 * 1024)}MB limit.`,
    );
  }
  if (!request.body) {
    return fail(
      400,
      "invalid_multipart",
      "Send the tarball and manifest as multipart/form-data.",
    );
  }

  let form: FormData;
  try {
    // Re-wrapped around a counting stream so the cap holds against a body that
    // lied about (or omitted) its length. `duplex: "half"` is required by
    // undici for a streamed request body.
    const limited = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body.pipeThrough(limitBytes(MAX_BODY_BYTES)),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    form = await limited.formData();
  } catch (error) {
    if (isOversize(error)) {
      return fail(
        413,
        "payload_too_large",
        `The upload is larger than the ${MAX_TARBALL_BYTES / (1024 * 1024)}MB limit.`,
      );
    }
    return fail(
      400,
      "invalid_multipart",
      "The request body is not readable multipart/form-data.",
    );
  }

  const rawManifest = form.get("manifest");
  if (typeof rawManifest !== "string" || rawManifest.length === 0) {
    return fail(
      400,
      "invalid_manifest",
      "Send a `manifest` field containing the publish manifest as JSON.",
    );
  }
  if (rawManifest.length > MAX_MANIFEST_CHARS) {
    return fail(400, "invalid_manifest", "The manifest is too large.");
  }

  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(rawManifest));
  } catch {
    return fail(
      400,
      "invalid_manifest",
      "The manifest must be JSON carrying at least `engineVersion`.",
    );
  }

  const tarball = form.get("tarball");
  if (typeof tarball === "string" || tarball === null) {
    return fail(
      400,
      "missing_tarball",
      "Send the publish tarball as a `tarball` file field.",
    );
  }
  if (tarball.size === 0) {
    return fail(400, "invalid_tarball", "The uploaded tarball is empty.");
  }
  if (tarball.size > MAX_TARBALL_BYTES) {
    return fail(
      413,
      "payload_too_large",
      `The tarball is larger than the ${MAX_TARBALL_BYTES / (1024 * 1024)}MB limit.`,
    );
  }

  const bytes = new Uint8Array(await tarball.arrayBuffer());
  // The only thing this route knows about the CONTENT: it is gzipped. The
  // archive itself stays opaque here — unpacking is the build task's job, on a
  // host that can afford it.
  if (bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) {
    return fail(
      400,
      "invalid_tarball",
      "The upload is not a gzipped tarball (`.tar.gz`).",
    );
  }

  const buildId = randomUUID();
  const key = buildArtifactKey(environmentId, buildId);
  await writeArtifact(key, bytes);

  try {
    const build = await buildService.create({
      id: buildId,
      environmentId,
      artifactPath: key,
      manifest,
      engineVersion: manifest.engineVersion,
      actor: `publish_token:${verified.tokenId}`,
    });
    return Response.json(
      { buildId: build.id, status: build.status },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // Nothing was queued, so nothing may be left on disk.
    await removeArtifact(key).catch(() => {});
    if (error instanceof BuildInFlightError) {
      return fail(409, error.code, error.message);
    }
    throw error;
  }
}
