import type { ResolvedCloud } from "./cloud-config.js";
import { resolveCloud } from "./cloud-config.js";
import type { CloudClient, FetchLike } from "./cloud-http.js";
import { createCloudClient } from "./cloud-http.js";
import type { CloudCredential } from "./credentials.js";
import { readCloudCredential, writeCloudCredential } from "./credentials.js";

/**
 * The three lines every cloud command starts with — resolve the host, find the
 * stored session, build a client — in one place so they cannot drift apart.
 *
 * The `--cloud` flag is parsed by each COMMAND rather than by the router's
 * global flag parser, on purpose: `parseGlobalFlags` owns the flags that every
 * operate-an-instance command honours, and adding a cloud-only flag there would
 * change how a dozen unrelated commands parse their argv. Commands that talk to
 * the cloud declare `--cloud` in their own `parseArgs` and hand the value here.
 */

/** Thrown when a command needs a session and there is none stored. */
export class NotLoggedInError extends Error {
  readonly cloudHost: string;
  readonly hint: string;

  constructor(cloud: ResolvedCloud) {
    super(`Not signed in to ${cloud.host}.`);
    this.name = "NotLoggedInError";
    this.cloudHost = cloud.host;
    // BOTH doors named, matching `cloud-refusals.ts`'s 401 hint: a reader on a
    // machine with no browser must be told the email flow exists rather than
    // being handed a command that cannot work there.
    const suffix = cloud.explicit ? ` --cloud ${cloud.baseUrl}` : "";
    this.hint = `Run \`hogsend login${suffix}\` (or \`hogsend login --email you@example.com${suffix}\` on a machine with no browser).`;
  }
}

export interface CloudSessionOptions {
  /** `--cloud <url>`, when given. */
  cloud?: string;
  /** Overridable so tests never read a real home directory. */
  home?: string;
  /** Injected for tests; production uses global fetch. */
  fetchImpl?: FetchLike;
  cwd?: string;
}

export interface CloudSession {
  cloud: ResolvedCloud;
  credential: CloudCredential | undefined;
  client: CloudClient;
}

/** Resolve the host and build a client, authenticated if a session is stored. */
export function openCloudSession(
  options: CloudSessionOptions = {},
): CloudSession {
  const cloud = resolveCloud(
    options.cloud === undefined ? {} : { cloud: options.cloud },
    options.cwd,
  );
  const credential = readCloudCredential(cloud.host, options.home);
  const client = createCloudClient({
    baseUrl: cloud.baseUrl,
    ...(credential ? { token: credential.token } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { cloud, credential, client };
}

/** What `storeCloudLogin` could resolve about a freshly minted session. */
export interface StoredLoginLabels {
  user: string | undefined;
  organization: string | undefined;
}

/**
 * Persist a freshly minted session, then label it. THE landing sequence for
 * every login path (the device flow and the email one), in one place because
 * the ORDER is the point:
 *
 *  1. the token is written FIRST, before anything else can fail. A session
 *     that was issued but not stored leaves the human signed in as far as the
 *     cloud is concerned and signed out as far as their machine is, with no
 *     way to tell why;
 *  2. only then is `whoami` called, to record the labels so `hogsend whoami`
 *     reads offline and the credentials file is self-describing;
 *  3. and a cloud that cannot answer that call changes nothing: the labels are
 *     a convenience, the credential is the thing.
 */
export async function storeCloudLogin(input: {
  cloud: ResolvedCloud;
  token: string;
  /** `--cloud <url>`, when it was given, so the re-opened session matches. */
  cloudFlag?: string;
  home?: string;
  fetchImpl?: FetchLike;
}): Promise<StoredLoginLabels> {
  const write = (labels: StoredLoginLabels) =>
    writeCloudCredential(
      input.cloud.host,
      {
        token: input.token,
        ...(labels.user ? { userLabel: labels.user } : {}),
        ...(labels.organization ? { orgLabel: labels.organization } : {}),
        createdAt: new Date().toISOString(),
      },
      input.home,
    );

  write({ user: undefined, organization: undefined });

  try {
    const session = openCloudSession({
      ...(input.cloudFlag === undefined ? {} : { cloud: input.cloudFlag }),
      ...(input.home === undefined ? {} : { home: input.home }),
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    });
    const who = await session.client.get<{
      user: { email: string };
      organization: { name: string };
    }>("/api/cli/session");
    const labels = {
      user: who.user.email,
      organization: who.organization.name,
    };
    write(labels);
    return labels;
  } catch {
    return { user: undefined, organization: undefined };
  }
}

/** The same, but refusing when there is no stored session. */
export function requireCloudSession(
  options: CloudSessionOptions = {},
): CloudSession & { credential: CloudCredential } {
  const session = openCloudSession(options);
  if (!session.credential) throw new NotLoggedInError(session.cloud);
  return { ...session, credential: session.credential };
}
