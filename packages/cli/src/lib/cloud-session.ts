import type { ResolvedCloud } from "./cloud-config.js";
import { resolveCloud } from "./cloud-config.js";
import type { CloudClient, FetchLike } from "./cloud-http.js";
import { createCloudClient } from "./cloud-http.js";
import type { CloudCredential } from "./credentials.js";
import { readCloudCredential } from "./credentials.js";

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
    this.hint = cloud.explicit
      ? `Run \`hogsend login --cloud ${cloud.baseUrl}\`.`
      : "Run `hogsend login`.";
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

/** The same, but refusing when there is no stored session. */
export function requireCloudSession(
  options: CloudSessionOptions = {},
): CloudSession & { credential: CloudCredential } {
  const session = openCloudSession(options);
  if (!session.credential) throw new NotLoggedInError(session.cloud);
  return { ...session, credential: session.credential };
}
