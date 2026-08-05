import { hostname } from "node:os";
import {
  type BuildStatusResponse,
  buildManifest,
  buildPublishTarball,
  type CloudSession,
  type EnvironmentListResponse,
  findScaffoldRoot,
  openCloudSession,
  requireCloudSession,
  resolveEngineVersion,
  selectEnvironment,
  storeCloudLogin,
  type UploadResult,
  uploadPublish,
  verifyEmailCode,
} from "@hogsend/cli/cloud";
import { z } from "zod";
import { cloudFailure, mapCloudError, needsAuth } from "../lib/cloud-result.js";
import { defineTool, type McpTool } from "../lib/tool.js";

/**
 * The `cloud_*` tools — scaffold → signup → publish → status, without an agent
 * shelling out (PRD 18).
 *
 * THREE PROPERTIES HOLD THIS FILE TOGETHER, and each is a rule rather than a
 * preference:
 *
 *  1. **STDIO ONLY.** These act on the OPERATOR'S machine and the OPERATOR'S
 *     credentials file. They have no business on a tenant's hosted instance,
 *     where "the machine" is a shared server and "the credentials" would be
 *     somebody else's. They are registered by `registerCloudTools`, which the
 *     stdio bin calls and `routes.ts` does not — absence on the hosted variant
 *     is STRUCTURAL, not a flag somebody can forget to set.
 *  2. **THE TOKEN NEVER CROSSES THE WIRE.** `cloud_verify` mints a session and
 *     writes it to `~/.hogsend/credentials.json` through the CLI's own writer;
 *     what it RETURNS is who you are, never what you hold. An MCP result is
 *     transcript, and a transcript is exactly where a bearer token must not be.
 *  3. **NOTHING IS REIMPLEMENTED.** Every line of the actual work — the OTP
 *     exchange, the tarball's hard excludes, the credential write, the refusal
 *     vocabulary — comes from `@hogsend/cli/cloud`. This file is argument
 *     parsing and result shaping. When the CLI's publish learns something new,
 *     these tools inherit it.
 *
 * The config funnel is the CLI's too (`HOGSEND_CLOUD_URL`, then the `.env` in
 * cwd, then the default), so a session minted here works in the terminal and a
 * session minted in the terminal works here. That interchangeability is the
 * whole point of not owning a second credentials store.
 */

/** `--cloud <url>`'s tool-shaped twin, on every tool that talks to the cloud. */
const cloudUrl = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Control-plane URL. Defaults to HOGSEND_CLOUD_URL, then the managed cloud.",
  );

const email = z
  .string()
  .min(3)
  .max(254)
  .describe("The email address the sign-in code is sent to.");

/** Open a session WITHOUT requiring one — for the unauthenticated tools. */
function anonymousSession(cloud?: string): CloudSession {
  return openCloudSession(cloud === undefined ? {} : { cloud });
}

/**
 * `cloud_signup` — start the email sign-in.
 *
 * There is no server-side handle to hand back: the control plane keys the OTP
 * by EMAIL (it is the identifier the code is mailed to and verified against),
 * so the pending handle IS the address. Returning it explicitly means the agent
 * carries one value from this call to `cloud_verify` rather than having to know
 * that.
 *
 * The answer is deliberately identical for a brand-new address and a
 * registered one — the control plane refuses to leak which, and a tool that
 * "helpfully" reported it would be an account-existence oracle with an agent
 * attached to it.
 */
export function createCloudSignupTool(): McpTool<{
  email: typeof email;
  cloudUrl: typeof cloudUrl;
}> {
  return defineTool({
    name: "cloud_signup",
    description:
      "Start Hogsend Cloud sign-in: mail a one-time code to an address. Works for a brand-new account and an existing one alike — the answer does not say which. Follow with cloud_verify.",
    inputSchema: { email, cloudUrl },
    run: async (input) => {
      const session = anonymousSession(input.cloudUrl);
      try {
        const sent = await session.client.post<{
          status: string;
          expiresInSeconds: number;
        }>("/api/cli/signup", { email: input.email.trim().toLowerCase() });
        return {
          ok: true as const,
          status: "sent" as const,
          /** Hand this back to `cloud_verify` — it is the pending handle. */
          email: input.email.trim().toLowerCase(),
          expiresInSeconds: sent.expiresInSeconds,
          cloud: session.cloud.baseUrl,
          next: "Call `cloud_verify` with that email and the code from the inbox.",
        };
      } catch (error) {
        return mapCloudError(error, { cloudHost: session.cloud.host });
      }
    },
  });
}

/**
 * `cloud_verify` — finish the sign-in and STORE the session.
 *
 * Uses `verifyEmailCode` — the VERIFY LEG ALONE — and not the CLI's whole
 * `runEmailLogin`, which sends a code before verifying one. That distinction
 * is the difference between working and not: `cloud_signup` already mailed the
 * code, and a second send ROTATES it server-side, so a verify that re-sent
 * would reject the very code the agent is holding. (Found by driving the tools
 * against a real control plane; the scripted test had accepted it.)
 */
export function createCloudVerifyTool(): McpTool<{
  email: typeof email;
  otp: z.ZodString;
  org: z.ZodOptional<z.ZodString>;
  cloudUrl: typeof cloudUrl;
}> {
  return defineTool({
    name: "cloud_verify",
    description:
      "Finish Hogsend Cloud sign-in with the emailed code. Stores the session in ~/.hogsend/credentials.json (the same file the hogsend CLI uses). Never returns the token.",
    inputSchema: {
      email,
      otp: z.string().min(1).max(32).describe("The code from the email."),
      org: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Organization name, used only when this account has none yet.",
        ),
      cloudUrl,
    },
    run: async (input) => {
      const session = anonymousSession(input.cloudUrl);
      try {
        const result = await verifyEmailCode(
          {
            email: input.email.trim().toLowerCase(),
            otp: input.otp,
            label: `mcp@${hostname()}`,
            ...(input.org === undefined ? {} : { org: input.org }),
          },
          { client: session.client },
        );

        // Stored through the CLI's own writer — same file, same 0600, same
        // atomic replace, same labels. That is what makes the session usable
        // from the terminal a minute later.
        const labels = await storeCloudLogin({
          cloud: session.cloud,
          token: result.token,
          ...(input.cloudUrl === undefined
            ? {}
            : { cloudFlag: input.cloudUrl }),
        });

        // NOTE what is absent: `result.token`. It went to the credentials file
        // and nowhere else.
        return {
          ok: true as const,
          created: result.created,
          userId: result.userId,
          organizationId: result.organizationId,
          environmentId: result.environmentId,
          note: result.note,
          user: labels.user ?? null,
          organization: labels.organization ?? null,
          cloud: session.cloud.baseUrl,
          sessionStoredAt: "~/.hogsend/credentials.json",
        };
      } catch (error) {
        return mapCloudError(error, { cloudHost: session.cloud.host });
      }
    },
  });
}

/** `cloud_whoami` — who this machine is signed in as, and what it can deploy to. */
export function createCloudWhoamiTool(): McpTool<{
  cloudUrl: typeof cloudUrl;
}> {
  return defineTool({
    name: "cloud_whoami",
    description:
      "Who this machine is signed in to Hogsend Cloud as, plus the organization's environments and their stack status.",
    inputSchema: { cloudUrl },
    run: async (input) => {
      let session: ReturnType<typeof requireCloudSession>;
      try {
        session = requireCloudSession(
          input.cloudUrl === undefined ? {} : { cloud: input.cloudUrl },
        );
      } catch (error) {
        return mapCloudError(error, {
          cloudHost: anonymousSession(input.cloudUrl).cloud.host,
        });
      }

      try {
        // ASKED, not read from the file: a session revoked in the dashboard
        // still looks fine on disk, and "am I signed in" is exactly the
        // question where that difference matters.
        const who = await session.client.get<{
          user: { id: string; email: string; name: string };
          organization: { id: string; name: string; slug: string | null };
          role: string;
        }>("/api/cli/session");
        const envs = await session.client.get<EnvironmentListResponse>(
          "/api/cli/environments",
        );
        return {
          ok: true as const,
          cloud: session.cloud.baseUrl,
          user: who.user,
          organization: who.organization,
          role: who.role,
          environments: envs.environments.map((row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind,
            stackStatus: row.stackStatus,
            engineVersion: row.engineVersion,
          })),
        };
      } catch (error) {
        return mapCloudError(error, { cloudHost: session.cloud.host });
      }
    },
  });
}

/**
 * `cloud_publish` — upload the scaffold at `cwd` and return the build id.
 *
 * RETURNS IMMEDIATELY, on purpose. A tool call that blocked for the minutes a
 * first publish takes would hold the agent's turn hostage and time out in most
 * hosts; `cloud_build_status` is how the agent watches. That split is also what
 * lets an agent do something useful in between.
 */
export function createCloudPublishTool(): McpTool<{
  cwd: z.ZodOptional<z.ZodString>;
  env: z.ZodOptional<z.ZodString>;
  allowUpgrade: z.ZodOptional<z.ZodBoolean>;
  cloudUrl: typeof cloudUrl;
}> {
  return defineTool({
    name: "cloud_publish",
    description:
      "Publish a Hogsend app to Hogsend Cloud. Packs the scaffold at cwd (excluding .git, node_modules, dist and every .env*), uploads it, and returns the build id immediately — poll it with cloud_build_status.",
    inputSchema: {
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe("A directory inside the app. Defaults to the process cwd."),
      env: z
        .string()
        .min(1)
        .optional()
        .describe("Environment name. Defaults to the production environment."),
      allowUpgrade: z
        .boolean()
        .optional()
        .describe("Accept an engine-version change on the target stack."),
      cloudUrl,
    },
    run: async (input) => {
      const refusalCtx = (session: { cloud: { host: string } }) => ({
        cloudHost: session.cloud.host,
        ...(input.env === undefined ? {} : { envName: input.env }),
      });

      let session: ReturnType<typeof requireCloudSession>;
      try {
        session = requireCloudSession(
          input.cloudUrl === undefined ? {} : { cloud: input.cloudUrl },
        );
      } catch (error) {
        return mapCloudError(
          error,
          refusalCtx(anonymousSession(input.cloudUrl)),
        );
      }

      try {
        // The app, then the target, then the archive — the CLI's order, so a
        // version mismatch is named before a minute of packing.
        const scaffold = findScaffoldRoot(input.cwd ?? process.cwd());
        const engine = resolveEngineVersion(scaffold.dir);

        const listed = await session.client.get<EnvironmentListResponse>(
          "/api/cli/environments",
        );
        const environment = selectEnvironment(listed.environments, input.env);

        if (
          environment.engineVersion &&
          environment.engineVersion !== engine.version &&
          input.allowUpgrade !== true
        ) {
          return cloudFailure(
            "engine_version_mismatch",
            `Engine version mismatch (${environment.name}): the stack runs ${environment.engineVersion}, this app is built against ${engine.version} (from ${engine.source}).`,
            {
              hint: "If that change is intentional, call cloud_publish again with allowUpgrade: true.",
            },
          );
        }

        const packed = buildPublishTarball(scaffold.dir);
        const manifest = buildManifest({
          appName: scaffold.appName,
          engineVersion: engine.version,
          allowUpgrade: input.allowUpgrade === true,
        });

        const uploaded: UploadResult = await uploadPublish(
          {
            environmentId: environment.id,
            archive: packed.archive,
            manifest,
            filename: `${scaffold.appName.replace(/[^a-zA-Z0-9._-]/g, "-")}.tar.gz`,
          },
          {
            client: session.client,
            emit: () => {},
            sleep: async () => {},
            now: () => Date.now(),
          },
          refusalCtx(session),
        );

        return {
          ok: true as const,
          buildId: uploaded.buildId,
          status: uploaded.status,
          environment: { id: environment.id, name: environment.name },
          appName: scaffold.appName,
          engineVersion: engine.version,
          files: packed.entries.length,
          bytes: packed.archive.byteLength,
          next: "Poll `cloud_build_status` with that buildId until terminal is true.",
        };
      } catch (error) {
        return mapCloudError(error, refusalCtx(session));
      }
    },
  });
}

/**
 * The phase an agent should NARRATE, derived from the (build, stack) pair.
 *
 * The two statuses answer different questions and neither is sufficient alone:
 * during a first publish the build sits in `building` while the substrate it
 * will deploy onto is still being created (PRD 15/16), so reporting the build
 * status by itself would say "building" for minutes and mean "waiting".
 */
export type CloudBuildPhase =
  | "provisioning"
  | "building"
  | "succeeded"
  | "failed";

const PROVISIONING_STACK_STATUSES = new Set([
  "deferred",
  "requested",
  "provisioning",
]);

export function derivePhase(build: {
  status: string;
  terminal: boolean;
  stack?: { status: string } | null;
}): { phase: CloudBuildPhase; narrative: string } {
  const stack = build.stack?.status ?? null;

  if (build.status === "succeeded") {
    return { phase: "succeeded", narrative: "Deployed." };
  }
  if (build.status === "failed") {
    return { phase: "failed", narrative: "The build failed." };
  }
  if (stack === "error") {
    return {
      phase: "failed",
      narrative:
        "Provisioning failed for this environment, so the build has nothing to deploy onto.",
    };
  }
  if (stack !== null && PROVISIONING_STACK_STATUSES.has(stack)) {
    return {
      phase: "provisioning",
      narrative:
        "Creating this environment's instance — database, workers, DNS. A first publish spends a few minutes here before the build starts.",
    };
  }
  return { phase: "building", narrative: `Build is ${build.status}.` };
}

/** `cloud_build_status` — ONE poll. The agent owns the loop. */
export function createCloudBuildStatusTool(): McpTool<{
  buildId: z.ZodString;
  cloudUrl: typeof cloudUrl;
}> {
  return defineTool({
    name: "cloud_build_status",
    description:
      "Read one Hogsend Cloud build's status. Reports the provisioning phase separately from the build phase, so a first publish reads as 'provisioning' rather than a stalled build. Poll until terminal is true.",
    inputSchema: {
      buildId: z.string().min(1).describe("The id cloud_publish returned."),
      cloudUrl,
    },
    run: async (input) => {
      let session: ReturnType<typeof requireCloudSession>;
      try {
        session = requireCloudSession(
          input.cloudUrl === undefined ? {} : { cloud: input.cloudUrl },
        );
      } catch (error) {
        return mapCloudError(error, {
          cloudHost: anonymousSession(input.cloudUrl).cloud.host,
        });
      }

      try {
        const build = await session.client.get<BuildStatusResponse>(
          `/api/builds/${input.buildId}`,
        );
        const { phase, narrative } = derivePhase(build);
        return {
          ok: true as const,
          buildId: build.id,
          phase,
          narrative,
          terminal: build.terminal,
          build: {
            status: build.status,
            engineVersion: build.engineVersion,
            imageDigest: build.imageDigest,
            error: build.error,
            // Only ever present on a terminal build (the control plane
            // withholds it until then), which is also the only time it helps.
            logTail: build.logTail,
          },
          stack: build.stack ?? null,
          environmentId: build.environmentId,
        };
      } catch (error) {
        return mapCloudError(error, { cloudHost: session.cloud.host });
      }
    },
  });
}

export { needsAuth };
