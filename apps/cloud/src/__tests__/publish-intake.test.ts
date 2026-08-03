import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The publish intake, tested as the HTTP surface it is: real `Request`s with
 * real multipart bodies, against the route handler, over the real database and
 * a real (temporary) artifacts directory.
 *
 * The rules under test are the ones a mock would let through:
 *  - a refusal stores NOTHING — no row, and no file in the artifacts tree;
 *  - a token is scoped to ITS environment, and posting it at another one is a
 *    403 rather than an accepted upload;
 *  - the size cap survives a client that lies about `Content-Length`, which is
 *    the whole reason the body is metered as it is read.
 *
 * The artifacts root is repointed at a temp directory BEFORE `src/env.ts` is
 * imported, so the suite never writes into the repository.
 */
const ARTIFACTS_ROOT = mkdtempSync(join(tmpdir(), "hogsend-artifacts-"));
process.env.CLOUD_ARTIFACTS_DIR = ARTIFACTS_ROOT;

const { eq, inArray } = await import("drizzle-orm");
const { POST, MAX_BODY_BYTES, MAX_TARBALL_BYTES } = await import(
  "../../app/api/publish/[environmentId]/route"
);
const { db, sqlClient } = await import("../db");
const { runCloudMigrations } = await import("../db/migrator");
const { builds, environments, organizations } = await import("../db/schema");
const { env } = await import("../env");
const { buildService, MAX_QUEUED_BUILDS_PER_ENVIRONMENT } = await import(
  "../services/builds"
);
const { PublishTokenService } = await import("../services/publish-tokens");

const ORG = "publish-intake-test-org";
const tokens = new PublishTokenService(db);

/** Two bytes of gzip magic in front of some payload. A real `.tar.gz` starts
 * this way and the route checks exactly this much. */
function gzipBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x1f;
  bytes[1] = 0x8b;
  return bytes;
}

const MANIFEST = JSON.stringify({
  engineVersion: "0.56.0",
  appName: "acme-lifecycle",
  nodeVersion: "22",
  // An unknown key the CLI may add later; the route must keep it.
  entryPoints: ["src/index.ts"],
});

function publishUrl(environmentId: string): string {
  return `http://localhost:3004/api/publish/${environmentId}`;
}

function post(environmentId: string, request: Request): Promise<Response> {
  return POST(request, { params: Promise.resolve({ environmentId }) });
}

/** A well-formed multipart publish. */
function uploadRequest(
  environmentId: string,
  options: {
    token?: string;
    manifest?: string;
    tarball?: Uint8Array | "omit" | "string";
  } = {},
): Request {
  const form = new FormData();
  if (options.manifest !== undefined) {
    if (options.manifest !== "") form.set("manifest", options.manifest);
  } else {
    form.set("manifest", MANIFEST);
  }

  if (options.tarball === "string") {
    form.set("tarball", "not-a-file");
  } else if (options.tarball !== "omit") {
    const bytes = options.tarball ?? gzipBytes();
    form.set(
      "tarball",
      new File([bytes as BlobPart], "app.tar.gz", {
        type: "application/gzip",
      }),
    );
  }

  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return new Request(publishUrl(environmentId), {
    method: "POST",
    headers,
    body: form,
  });
}

/**
 * A body that STREAMS past the cap while claiming to be tiny — the lying
 * `Content-Length` case. Generated lazily so the test does not have to hold
 * 64MB in memory to prove the meter works.
 */
function oversizeStreamRequest(
  environmentId: string,
  token: string,
  declaredLength: string,
): Request {
  const boundary = "----hogsendtestboundary";
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="tarball"; filename="app.tar.gz"\r\n` +
      "Content-Type: application/gzip\r\n\r\n",
  );
  const megabyte = new Uint8Array(1024 * 1024);
  let sent = 0;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
    },
    pull(controller) {
      if (sent > MAX_BODY_BYTES) {
        controller.close();
        return;
      }
      sent += megabyte.byteLength;
      controller.enqueue(megabyte);
    },
  });

  return new Request(publishUrl(environmentId), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": declaredLength,
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

let seq = 0;

async function seedEnvironment(): Promise<{
  environmentId: string;
  token: string;
}> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `intake-env-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  const { token } = await tokens.mint({ environmentId: row.id });
  return { environmentId: row.id, token };
}

async function buildRows(environmentId: string) {
  return db
    .select()
    .from(builds)
    .where(eq(builds.environmentId, environmentId));
}

/**
 * The artifact files stored for ONE environment. Scoped rather than global so
 * each case can assert "this upload wrote nothing" without being coupled to
 * what the successful cases left in the shared temp root.
 */
function storedArtifacts(environmentId: string): string[] {
  const dir = join(ARTIFACTS_ROOT, environmentId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Publish Intake Test Org", region: "us" });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("POST /api/publish/:environmentId — authentication", () => {
  it("refuses an upload with no token, storing nothing", async () => {
    const { environmentId } = await seedEnvironment();
    const response = await post(environmentId, uploadRequest(environmentId));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "missing_token" });
    expect(await buildRows(environmentId)).toHaveLength(0);
    expect(storedArtifacts(environmentId)).toHaveLength(0);
  });

  it("refuses a token that is not one of ours", async () => {
    const { environmentId } = await seedEnvironment();
    const response = await post(
      environmentId,
      uploadRequest(environmentId, { token: "hspub_not-a-real-token" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
    expect(await buildRows(environmentId)).toHaveLength(0);
    expect(storedArtifacts(environmentId)).toHaveLength(0);
  });

  it("refuses a VALID token aimed at another environment with 403", async () => {
    const a = await seedEnvironment();
    const b = await seedEnvironment();

    const response = await post(
      b.environmentId,
      uploadRequest(b.environmentId, { token: a.token }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "forbidden_environment",
    });
    // Neither environment got a build out of it.
    expect(await buildRows(a.environmentId)).toHaveLength(0);
    expect(await buildRows(b.environmentId)).toHaveLength(0);
    expect(storedArtifacts(a.environmentId)).toHaveLength(0);
    expect(storedArtifacts(b.environmentId)).toHaveLength(0);
  });

  it("refuses a path that is not a uuid, even with a real token", async () => {
    const { token } = await seedEnvironment();
    const response = await post(
      "not-a-uuid",
      uploadRequest("not-a-uuid", { token }),
    );

    expect(response.status).toBe(403);
  });

  it("refuses a rotated-away token", async () => {
    const { environmentId, token } = await seedEnvironment();
    await tokens.rotate({ environmentId });

    const response = await post(
      environmentId,
      uploadRequest(environmentId, { token }),
    );
    expect(response.status).toBe(401);
    expect(await buildRows(environmentId)).toHaveLength(0);
  });
});

describe("POST /api/publish/:environmentId — a valid upload", () => {
  it("stores the artifact, queues a build and answers 202", async () => {
    const { environmentId, token } = await seedEnvironment();
    const bytes = gzipBytes(2048);

    const response = await post(
      environmentId,
      uploadRequest(environmentId, { token, tarball: bytes }),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      buildId: string;
      status: string;
    };
    expect(body.status).toBe("queued");

    const rows = await buildRows(environmentId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("no build row");
    expect(row.id).toBe(body.buildId);
    expect(row.status).toBe("queued");
    expect(row.engineVersion).toBe("0.56.0");
    expect(row.artifactPath).toBe(`${environmentId}/${body.buildId}.tar.gz`);
    // Unknown manifest keys survive: the row is what was uploaded.
    expect(row.manifest).toMatchObject({
      engineVersion: "0.56.0",
      appName: "acme-lifecycle",
      entryPoints: ["src/index.ts"],
    });

    const stored = await readFile(join(ARTIFACTS_ROOT, row.artifactPath));
    expect(new Uint8Array(stored)).toEqual(bytes);
  });

  it("queues rather than races a second publish to a busy environment", async () => {
    const { environmentId, token } = await seedEnvironment();

    const first = await post(
      environmentId,
      uploadRequest(environmentId, { token }),
    );
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as { buildId: string };

    // The environment is busy the moment the first build leaves `queued`.
    await buildService.transition({
      buildId: accepted.buildId,
      to: "building",
      expectedFrom: "queued",
    });

    const second = await post(
      environmentId,
      uploadRequest(environmentId, { token }),
    );
    // ACCEPTED, not refused: the publish waits its turn rather than being
    // discarded (PRD 08: "a second publish to a busy environment SHALL queue,
    // never race").
    expect(second.status).toBe(202);
    const queued = (await second.json()) as {
      buildId: string;
      status: string;
    };
    expect(queued.status).toBe("queued");

    const rows = await buildRows(environmentId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === accepted.buildId)?.status).toBe(
      "building",
    );
    expect(rows.find((row) => row.id === queued.buildId)?.status).toBe(
      "queued",
    );
    // Both artifacts are on disk — the queued build still needs its tarball.
    expect(storedArtifacts(environmentId).sort()).toEqual(
      [`${accepted.buildId}.tar.gz`, `${queued.buildId}.tar.gz`].sort(),
    );
  });

  it("refuses a publish past the queue depth, storing nothing", async () => {
    const { environmentId, token } = await seedEnvironment();

    const first = await post(
      environmentId,
      uploadRequest(environmentId, { token }),
    );
    const running = (await first.json()) as { buildId: string };
    await buildService.transition({
      buildId: running.buildId,
      to: "building",
      expectedFrom: "queued",
    });

    for (let n = 0; n < MAX_QUEUED_BUILDS_PER_ENVIRONMENT; n += 1) {
      const accepted = await post(
        environmentId,
        uploadRequest(environmentId, { token }),
      );
      expect(accepted.status).toBe(202);
    }

    const refused = await post(
      environmentId,
      uploadRequest(environmentId, { token }),
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({ error: "build_queue_full" });

    // The refusal left neither a row nor a file: the running build, its
    // artifact, and the ones that legitimately queued — nothing more.
    const rows = await buildRows(environmentId);
    expect(rows).toHaveLength(1 + MAX_QUEUED_BUILDS_PER_ENVIRONMENT);
    expect(storedArtifacts(environmentId)).toHaveLength(
      1 + MAX_QUEUED_BUILDS_PER_ENVIRONMENT,
    );
  });
});

describe("POST /api/publish/:environmentId — refusals", () => {
  it("refuses a manifest that is missing or unparseable", async () => {
    const { environmentId, token } = await seedEnvironment();

    for (const manifest of ["", "{", JSON.stringify({ appName: "acme" })]) {
      const response = await post(
        environmentId,
        uploadRequest(environmentId, { token, manifest }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "invalid_manifest",
      });
    }

    expect(await buildRows(environmentId)).toHaveLength(0);
    expect(storedArtifacts(environmentId)).toHaveLength(0);
  });

  it("refuses a missing tarball, a non-file tarball and an empty one", async () => {
    const { environmentId, token } = await seedEnvironment();

    const missing = await post(
      environmentId,
      uploadRequest(environmentId, { token, tarball: "omit" }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "missing_tarball" });

    const notAFile = await post(
      environmentId,
      uploadRequest(environmentId, { token, tarball: "string" }),
    );
    expect(notAFile.status).toBe(400);
    expect(await notAFile.json()).toMatchObject({ error: "missing_tarball" });

    const empty = await post(
      environmentId,
      uploadRequest(environmentId, { token, tarball: new Uint8Array(0) }),
    );
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: "invalid_tarball" });

    expect(await buildRows(environmentId)).toHaveLength(0);
    expect(storedArtifacts(environmentId)).toHaveLength(0);
  });

  it("refuses a file that is not gzipped", async () => {
    const { environmentId, token } = await seedEnvironment();
    const response = await post(
      environmentId,
      uploadRequest(environmentId, {
        token,
        tarball: new TextEncoder().encode("PK this is a zip"),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_tarball" });
    expect(await buildRows(environmentId)).toHaveLength(0);
    expect(storedArtifacts(environmentId)).toHaveLength(0);
  });

  it("refuses an honest oversize upload from its Content-Length alone", async () => {
    const { environmentId, token } = await seedEnvironment();
    const request = uploadRequest(environmentId, { token });
    request.headers.set("content-length", String(MAX_BODY_BYTES + 1));

    const response = await post(environmentId, request);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "payload_too_large",
    });
    expect(await buildRows(environmentId)).toHaveLength(0);
    expect(storedArtifacts(environmentId)).toHaveLength(0);
  });

  it("refuses an oversize body that LIED about its Content-Length", async () => {
    const { environmentId, token } = await seedEnvironment();

    const response = await post(
      environmentId,
      oversizeStreamRequest(environmentId, token, "512"),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "payload_too_large",
    });
    expect(await buildRows(environmentId)).toHaveLength(0);
    expect(storedArtifacts(environmentId)).toHaveLength(0);
  }, 60_000);

  it("caps the tarball itself below the body cap", () => {
    // The body cap allows for MIME framing; the tarball is what is promised.
    expect(MAX_TARBALL_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_BODY_BYTES).toBeGreaterThan(MAX_TARBALL_BYTES);
  });
});
