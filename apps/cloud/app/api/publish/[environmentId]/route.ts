import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildArtifactKey, getArtifactStore } from "@/src/lib/artifacts";
import { promoteDeferredStack } from "@/src/lib/deferred-stacks";
import {
  authorizePublishEnvironment,
  bearerToken,
  checkEngineVersion,
  resolvePublishCredential,
} from "@/src/lib/publish-guards";
import { createAndEnqueueBuild } from "@/src/pipeline/build-enqueue";
import { BuildQueueFullError } from "@/src/services/errors";

/**
 * `POST /api/publish/:environmentId` — the publish intake (PRD 08 task 2).
 *
 * It STORES and QUEUES; it does not build. The tarball goes to
 * `CLOUD_ARTIFACTS_DIR`, a `queued` build row goes to the database, the build
 * task is enqueued, and the answer is 202 — the cloud-worker is what walks the
 * record through the machine (`src/pipeline/build.ts`). The enqueue cannot fail
 * the upload: a queued-but-unenqueued build is picked up by the minute sweep.
 *
 * The rules, in the order they are applied — the order IS the security posture:
 *
 *  1. **Authenticate before reading a byte.** `proxy.ts` excludes `/api` from
 *     the session matcher, so this handler authenticates itself: a bearer
 *     credential, checked against its sha256. Two are accepted — an
 *     environment-bound `hspub_…` publish token, and a person-bound `hscli_…`
 *     CLI session from `hogsend login` — and `lib/publish-guards.ts` owns the
 *     difference. An upload with no valid credential is refused before the body
 *     is touched, so an anonymous caller cannot make this process buffer 64MB.
 *  2. **The credential must reach THIS environment.** A publish token valid for
 *     environment A posting to environment B is 403, not 401: it is a real
 *     credential used against a target it does not own, and saying so is not a
 *     leak — the holder already knows their own environment id. A CLI session
 *     must be in the environment's ORGANIZATION and its human must still hold a
 *     publishing role, re-read from the membership on every upload.
 *  3. **The size cap is enforced TWICE.** `Content-Length` is a hint, checked
 *     first so an honest oversize upload is refused without reading it; the
 *     body is then piped through a counting stream that ERRORS past the cap, so
 *     a lying (or absent) `Content-Length` cannot buy a byte more than the cap.
 *  4. **The engine version must match the stack.** A tarball built against a
 *     different engine than the stack is running is a migration, not a deploy,
 *     so it is refused 409 unless the manifest says `allowUpgrade`. Checked
 *     after the manifest is parsed and BEFORE anything is written.
 *  5. **A rejected upload leaves nothing.** Every refusal above happens before
 *     any write. The one refusal that can happen after the file is on disk — a
 *     full publish queue — deletes the file it wrote.
 *  6. **An accepted upload ASKS FOR THE SUBSTRATE.** Under
 *     `CLOUD_PROVISION_ON=first-publish` (PRD 15) a new tenant's stack is born
 *     `deferred` and nothing provisions it until somebody publishes. This
 *     route promotes it (`deferred → requested`, a guarded edge, so two
 *     concurrent publishes promote once) and enqueues — after every refusal
 *     above, so a rejected upload still provisions nothing. The build then
 *     WAITS for the stack to come up (`pipeline/build.ts`), and
 *     `GET /api/builds/:id` carries the stack's phase so the CLI can say what
 *     it is waiting for.
 *
 * A busy environment is NOT a refusal. A publish sent while another build is
 * running is QUEUED behind it (PRD 08: "a second publish to a busy environment
 * SHALL queue, never race") and answered 202 like any other. The only queueing
 * refusal is depth: past `MAX_QUEUED_BUILDS_PER_ENVIRONMENT` waiting publishes
 * the answer is 429 with `retry-after`, because each waiting build pins a
 * tarball of tenant source on a shared build host.
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
  /**
   * `hogsend publish --allow-upgrade`. The caller stating that a version
   * disagreement with the stack is intentional; without it the intake refuses.
   */
  allowUpgrade: z.boolean().optional(),
});

/** Marker the limiting stream fails with, recognised below as a 413. */
const OVERSIZE = "hogsend:body-too-large";

// The handler writes to disk and to the database; nothing about it may be
// cached or prerendered.
export const dynamic = "force-dynamic";

function fail(
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error, message },
    { status, headers: { "cache-control": "no-store", ...headers } },
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

  const token = bearerToken(request.headers);
  if (!token) {
    return fail(
      401,
      "missing_token",
      "Send a credential as `Authorization: Bearer hspub_…` (environment publish token) or `Bearer hscli_…` (a `hogsend login` session).",
    );
  }

  const credential = await resolvePublishCredential({ token });
  if (!credential) {
    return fail(
      401,
      "invalid_token",
      "That credential is not valid. Rotate the environment's publish token, or run `hogsend login` again.",
    );
  }

  const authorized = await authorizePublishEnvironment({
    credential,
    environmentId,
  });
  if (!authorized.ok) {
    const { status, error, message } = authorized.refusal;
    return fail(status, error, message);
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

  const version = await checkEngineVersion({
    environmentId,
    manifestVersion: manifest.engineVersion,
    allowUpgrade: manifest.allowUpgrade === true,
  });
  if (!version.ok) {
    return Response.json(
      {
        error: "engine_version_mismatch",
        message: `This stack runs engine ${version.stackVersion}; the upload is built against ${version.manifestVersion}. Publish with --allow-upgrade to change it.`,
        stackVersion: version.stackVersion,
        manifestVersion: version.manifestVersion,
      },
      { status: 409, headers: { "cache-control": "no-store" } },
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

  // The upload is going to be accepted. THIS is the moment the tenant's
  // substrate is asked for under `CLOUD_PROVISION_ON=first-publish` (PRD 15):
  // after every refusal above (so a rejected upload provisions nothing) and
  // before the build row exists (so the provisioner has a head start on the
  // pipeline that will wait for it). A no-op for a stack in any other status,
  // and a failed promotion never fails the publish — see `deferred-stacks.ts`.
  await promoteDeferredStack({
    environmentId,
    actor: authorized.actor,
  }).catch((error) => {
    console.error(
      `[cloud] Could not promote the deferred stack for environment ${environmentId}:`,
      error,
    );
  });

  const buildId = randomUUID();
  const key = buildArtifactKey(environmentId, buildId);
  await getArtifactStore().put(key, bytes);

  try {
    const build = await createAndEnqueueBuild({
      id: buildId,
      environmentId,
      artifactPath: key,
      manifest,
      engineVersion: manifest.engineVersion,
      actor: authorized.actor,
    });
    return Response.json(
      { buildId: build.id, status: build.status },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // Nothing was queued, so nothing may be left in the store.
    await getArtifactStore()
      .remove(key)
      .catch(() => {});
    if (error instanceof BuildQueueFullError) {
      // Backpressure, not breakage: the queue drains one build at a time and
      // the sweep ticks every minute, so a retry a minute later gets in.
      return fail(429, error.code, error.message, { "retry-after": "60" });
    }
    throw error;
  }
}
