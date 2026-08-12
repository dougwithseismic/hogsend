import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SES_ABUSE_DETAIL_TYPES,
  SES_EVENT_SOURCE,
} from "../eventbridge/events";
import { EVENTBRIDGE_SECRET_HEADER } from "../eventbridge/verify";

/**
 * `scripts/aws-bootstrap-events.sh`, proved with no AWS account.
 *
 * `docs/ses-production-access-request.md` tells AWS "we subscribe to the SES
 * EventBridge events on the default bus and act on all four detail-types". The
 * in-repo half of that claim has its own tests; this file covers the half that
 * is infrastructure — the rule, the connection, the API destination and the
 * target that make SES's events reach the ingress at all.
 *
 * Every `aws` invocation goes through a STUB on the PATH, which records its
 * argv and answers the two reads the script derives values from. Nothing here
 * can reach AWS: the real CLI is never on the PATH these runs see.
 */

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(
  new URL("../../scripts/aws-bootstrap-events.sh", import.meta.url),
);
const ACCOUNT = "000000000000";
const ADMIN_ARN = `arn:aws:iam::${ACCOUNT}:user/doug`;
const RELAY_ARN = `arn:aws:iam::${ACCOUNT}:user/hogsend-cloud-relay`;
const PUBLIC_URL = "https://cloud.hogsend.com";
const REGIONS = ["us-east-1", "eu-west-1"];

/**
 * The stub. It answers only what the script READS BACK — a caller identity, an
 * account id, the ARNs of the two resources whose ARNs are inputs to the next
 * call, and put-targets' FailedEntryCount — and exits 0 for everything else.
 *
 * `AWS_STUB_ABSENT_REGIONS` / `AWS_STUB_ROLE_EXISTS` drive the existence probes,
 * because "create it" and "leave the live one alone" are different code paths
 * and both have to be provable. An absent resource answers the way the real
 * CLI does — a not-found NAMED in the error body — because the script now
 * reads the body to tell "not there" from "not allowed to ask".
 *
 * `AWS_STUB_FAIL=<cmd>:<subcmd>` makes exactly that verb fail with an
 * AccessDenied, and `AWS_STUB_TARGET_FAILURES` sets the FailedEntryCount
 * put-targets reports — the two body-level failure modes the script must not
 * swallow.
 */
const STUB = `#!/usr/bin/env bash
set -u
# Tab between arguments, RS between calls: a policy document is a multi-line
# argument, so newline cannot be the record separator.
{
  sep=""
  for arg in "$@"; do printf '%s%s' "$sep" "$arg"; sep=$'\\t'; done
  printf '\\x1e'
} >> "$AWS_STUB_LOG"

if [[ "\${AWS_STUB_FAIL:-}" == "$1:\${2:-}" ]]; then
  echo "An error occurred (AccessDenied) when calling the $1 \${2:-} operation" >&2
  exit 254
fi

absent_region() {
  local wanted="\${AWS_STUB_ABSENT_REGIONS:-}"
  [[ "$wanted" == "all" ]] && return 0
  for arg in "$@"; do
    case ",$wanted," in *",$arg,"*) return 0 ;; esac
  done
  return 1
}

not_found() {
  echo "An error occurred (ResourceNotFoundException) when calling the $1 operation" >&2
  exit 254
}

case "$1:\${2:-}" in
  sts:get-caller-identity)
    case "$*" in
      *"--query Arn"*) echo "$AWS_STUB_CALLER_ARN" ;;
      *"--query Account"*) echo "${ACCOUNT}" ;;
    esac ;;
  sns:create-topic)
    echo "arn:aws:sns:stub:${ACCOUNT}:hogsend-ses-events" ;;
  events:create-connection|events:update-connection)
    echo "arn:aws:events:stub:${ACCOUNT}:connection/hogsend-control-plane/c1" ;;
  events:create-api-destination|events:update-api-destination)
    echo "arn:aws:events:stub:${ACCOUNT}:api-destination/hogsend-ses-reputation/d1" ;;
  events:put-targets)
    echo "\${AWS_STUB_TARGET_FAILURES:-0}" ;;
  events:describe-connection|events:describe-api-destination)
    absent_region "$@" && not_found "$2"
    echo "{}" ;;
  iam:get-role)
    [[ -n "\${AWS_STUB_ROLE_EXISTS:-}" ]] || not_found "GetRole"
    echo "{}" ;;
esac
exit 0
`;

interface RunOptions {
  dryRun?: boolean;
  callerArn?: string;
  publicUrl?: string | null;
  secret?: string;
  /** Regions whose connection/destination the stub reports missing. */
  absentRegions?: string;
  roleExists?: boolean;
  /** `<cmd>:<subcmd>` the stub fails with an AccessDenied, e.g. `events:put-rule`. */
  awsFail?: string;
  /** The FailedEntryCount the stub's put-targets reports. */
  targetFailures?: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Every `aws` invocation, argv split. */
  calls: string[][];
}

let stubDir: string;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "hogsend-aws-stub-"));
  writeFileSync(join(stubDir, "aws"), STUB, { mode: 0o755 });
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

async function run(options: RunOptions = {}): Promise<RunResult> {
  const log = join(stubDir, `calls-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, "");
  const publicUrl =
    options.publicUrl === undefined ? PUBLIC_URL : options.publicUrl;

  // A CONTROLLED environment, not this process's: the script must not be able
  // to reach a real credential, a real `aws`, or this machine's CLOUD_* values.
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: `${stubDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: stubDir,
    AWS_STUB_LOG: log,
    AWS_STUB_CALLER_ARN: options.callerArn ?? ADMIN_ARN,
    AWS_STUB_ABSENT_REGIONS: options.absentRegions ?? "all",
    ...(options.roleExists ? { AWS_STUB_ROLE_EXISTS: "1" } : {}),
    ...(options.awsFail ? { AWS_STUB_FAIL: options.awsFail } : {}),
    ...(options.targetFailures !== undefined
      ? { AWS_STUB_TARGET_FAILURES: String(options.targetFailures) }
      : {}),
    ...(options.dryRun ? { DRY_RUN: "1" } : {}),
    ...(publicUrl === null ? {} : { CLOUD_PUBLIC_URL: publicUrl }),
    ...(options.secret ? { CLOUD_SES_EVENTBRIDGE_SECRET: options.secret } : {}),
  };

  let code = 0;
  let stdout = "";
  let stderr = "";
  try {
    const done = await execFileAsync("bash", [SCRIPT], { env });
    stdout = done.stdout;
    stderr = done.stderr;
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    code = failure.code ?? 1;
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
  }

  const calls = readFileSync(log, "utf8")
    .split("\u001e")
    .filter((record) => record.length > 0)
    .map((record) => record.split("\t"));

  return { code, stdout, stderr, calls };
}

/** Every recorded call whose leading argv matches. */
function callsFor(result: RunResult, ...prefix: string[]): string[][] {
  return result.calls.filter((call) =>
    prefix.every((token, index) => call[index] === token),
  );
}

/** The value of `--flag` on one recorded call. */
function flag(call: string[], name: string): string | undefined {
  const index = call.indexOf(name);
  return index === -1 ? undefined : call[index + 1];
}

describe("the preflight refusals", () => {
  it("refuses the RELAY credentials before it touches anything", async () => {
    const result = await run({ callerArn: RELAY_ARN });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("RELAY credentials");
    // The whole point: nothing was created under the wrong identity.
    expect(callsFor(result, "events")).toHaveLength(0);
    expect(callsFor(result, "sns")).toHaveLength(0);
    expect(callsFor(result, "iam")).toHaveLength(0);
  });

  it("refuses an endpoint EventBridge could never reach", async () => {
    const result = await run({ publicUrl: "http://localhost:3004" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CLOUD_PUBLIC_URL");
    expect(callsFor(result, "events")).toHaveLength(0);
  });

  it("refuses a missing endpoint rather than guessing one", async () => {
    const result = await run({ publicUrl: null });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CLOUD_PUBLIC_URL");
    expect(callsFor(result, "events")).toHaveLength(0);
  });

  it("refuses to rotate one region's secret when the other already has one", async () => {
    // us-east-1 has a live connection holding a secret AWS will never show us;
    // eu-west-1 has none. Generating one here would leave the two regions
    // signing with different values and the control plane holding neither.
    const result = await run({ absentRegions: "eu-west-1" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CLOUD_SES_EVENTBRIDGE_SECRET");
    expect(callsFor(result, "events", "create-connection")).toHaveLength(0);
    // And the refusal is followable even when the value is LOST: it names the
    // stranded connection's region and the delete that unblocks a re-run.
    expect(result.stderr).toContain("delete-connection");
    expect(result.stderr).toContain("us-east-1");
  });
});

describe("DRY_RUN", () => {
  it("prints every call it would make and makes none", async () => {
    const result = await run({ dryRun: true });

    expect(result.code).toBe(0);
    // The only calls a dry run makes are the two identity reads the existing
    // SNS half already makes to name the account back to the operator.
    // EXACTLY two — an empty log would satisfy `every` vacuously.
    expect(result.calls).toHaveLength(2);
    expect(result.calls.every((call) => call[0] === "sts")).toBe(true);

    for (const region of REGIONS) {
      expect(result.stdout).toContain(`=== ${region} ===`);
    }
    for (const verb of [
      "events put-rule",
      "events create-connection",
      "events create-api-destination",
      "events put-targets",
      "iam create-role",
    ]) {
      expect(result.stdout).toContain(verb);
    }
    expect(result.stdout).toContain("[dry-run]");
  });

  it("never prints the secret it would install", async () => {
    const result = await run({ dryRun: true, secret: "s3cret-value" });

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("s3cret-value");
    expect(result.stderr).not.toContain("s3cret-value");
  });

  it("never prints a MINTED secret either — a dry run installed it nowhere", async () => {
    const result = await run({ dryRun: true });

    expect(result.code).toBe(0);
    const minted = /CLOUD_SES_EVENTBRIDGE_SECRET=[0-9a-f]{32,}/;
    expect(result.stdout).not.toMatch(minted);
    expect(result.stderr).not.toMatch(minted);
  });
});

describe("the EventBridge wiring", () => {
  it("creates the rule on the DEFAULT bus in both regions", async () => {
    const result = await run({ secret: "shared-secret" });

    expect(result.code).toBe(0);
    const rules = callsFor(result, "events", "put-rule");
    expect(rules).toHaveLength(REGIONS.length);
    expect(rules.map((call) => flag(call, "--region")).sort()).toEqual(
      [...REGIONS].sort(),
    );
    for (const call of rules) {
      expect(flag(call, "--event-bus-name")).toBe("default");
      expect(flag(call, "--state")).toBe("ENABLED");
    }
  });

  it("matches aws.ses and EXACTLY the four detail-types we consume", async () => {
    const result = await run({ secret: "shared-secret" });

    const rules = callsFor(result, "events", "put-rule");
    expect(rules).toHaveLength(REGIONS.length);
    for (const call of rules) {
      const pattern = JSON.parse(flag(call, "--event-pattern") ?? "{}");
      expect(pattern.source).toEqual([SES_EVENT_SOURCE]);
      expect(pattern["detail-type"]).toEqual([...SES_ABUSE_DETAIL_TYPES]);
    }
  });

  it("holds the shared secret in a connection, under the header the ingress reads", async () => {
    const result = await run({ secret: "shared-secret" });

    const connections = callsFor(result, "events", "create-connection");
    expect(connections).toHaveLength(REGIONS.length);
    for (const call of connections) {
      expect(flag(call, "--authorization-type")).toBe("API_KEY");
      const auth = flag(call, "--auth-parameters") ?? "";
      expect(auth).toContain(`ApiKeyName=${EVENTBRIDGE_SECRET_HEADER}`);
      expect(auth).toContain("ApiKeyValue=shared-secret");
    }
  });

  it("points the API destination at the reputation endpoint", async () => {
    const result = await run({ secret: "shared-secret" });

    const destinations = callsFor(result, "events", "create-api-destination");
    expect(destinations).toHaveLength(REGIONS.length);
    for (const call of destinations) {
      expect(flag(call, "--invocation-endpoint")).toBe(
        `${PUBLIC_URL}/api/email/reputation`,
      );
      expect(flag(call, "--http-method")).toBe("POST");
      expect(flag(call, "--connection-arn")).toContain(":connection/");
    }
  });

  it("targets the destination with a role that may invoke it", async () => {
    const result = await run({ secret: "shared-secret" });

    const roles = callsFor(result, "iam", "create-role");
    expect(roles).toHaveLength(1);
    const trust = JSON.parse(
      flag(roles[0] ?? [], "--assume-role-policy-document") ?? "{}",
    );
    expect(JSON.stringify(trust)).toContain("events.amazonaws.com");

    const grants = callsFor(result, "iam", "put-role-policy");
    expect(grants).toHaveLength(1);
    const grant = JSON.parse(
      flag(grants[0] ?? [], "--policy-document") ?? "{}",
    );
    const statement = grant.Statement?.[0];
    // Exactly the verb a rule needs to reach an API destination, and no more.
    expect(statement.Action).toEqual("events:InvokeApiDestination");
    // The FULL ARNs, not a substring probe: `toContain(region)` would pass on
    // a resource list whose account segment was empty.
    expect(statement.Resource).toEqual(
      REGIONS.map(
        (region) =>
          `arn:aws:events:${region}:${ACCOUNT}:api-destination/hogsend-ses-reputation/*`,
      ),
    );

    const targets = callsFor(result, "events", "put-targets");
    expect(targets).toHaveLength(REGIONS.length);
    for (const call of targets) {
      const target = flag(call, "--targets") ?? "";
      expect(target).toContain("api-destination/");
      expect(target).toContain("RoleArn=");
    }
  });

  it("does not re-create a role that is already there", async () => {
    const result = await run({ secret: "shared-secret", roleExists: true });

    expect(callsFor(result, "iam", "create-role")).toHaveLength(0);
    // The grant is a PUT and re-asserting it is how the script converges.
    expect(callsFor(result, "iam", "put-role-policy")).toHaveLength(1);
  });

  it("leaves a live connection's secret alone when the operator supplied none", async () => {
    const result = await run({ absentRegions: "" });

    expect(result.code).toBe(0);
    expect(callsFor(result, "events", "create-connection")).toHaveLength(0);
    expect(callsFor(result, "events", "update-connection")).toHaveLength(0);
    // Still converges everything that is not the secret.
    expect(callsFor(result, "events", "put-rule")).toHaveLength(REGIONS.length);
    expect(callsFor(result, "events", "put-targets")).toHaveLength(
      REGIONS.length,
    );
    expect(result.stdout).toContain("unchanged");
  });

  it("updates a live connection when the operator supplied a secret", async () => {
    const result = await run({ absentRegions: "", secret: "rotated" });

    expect(callsFor(result, "events", "create-connection")).toHaveLength(0);
    expect(callsFor(result, "events", "update-connection")).toHaveLength(
      REGIONS.length,
    );
  });

  it("prints the env lines to paste, including a generated secret", async () => {
    const result = await run();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("apps/cloud/.env.local");
    expect(result.stdout).toContain("CLOUD_SES_SNS_TOPIC_ARN_US=");
    const line = result.stdout
      .split("\n")
      .find((entry) => entry.startsWith("CLOUD_SES_EVENTBRIDGE_SECRET="));
    expect(line).toBeDefined();
    // A real secret, not a placeholder: this run created connections holding it.
    expect(
      (line ?? "").slice("CLOUD_SES_EVENTBRIDGE_SECRET=".length).length,
    ).toBeGreaterThanOrEqual(32);
  });

  it("still grants the relay user its SNS subscribe policy", async () => {
    const result = await run({ secret: "shared-secret" });

    // The SNS half is untouched by any of this.
    expect(callsFor(result, "iam", "put-user-policy")).toHaveLength(1);
    expect(callsFor(result, "sns", "create-topic")).toHaveLength(
      REGIONS.length,
    );
  });
});

describe("failure is loud", () => {
  it("prints a minted secret to stderr before the AWS writes, so a mid-run failure cannot strand it", async () => {
    // us-east-1's put-rule dies (an IAM-propagation AccessDenied, say) AFTER
    // the connection holding the fresh secret was created. AWS keeps that key
    // write-only, so unless the secret was already on stderr, the failed run
    // leaves a live connection holding a value nobody can ever read back.
    const result = await run({ awsFail: "events:put-rule" });

    expect(result.code).not.toBe(0);
    const match = /CLOUD_SES_EVENTBRIDGE_SECRET=([0-9a-f]{64})/.exec(
      result.stderr,
    );
    expect(match).not.toBeNull();
    // And it is THE value the connection was created with, not a decoy.
    const connections = callsFor(result, "events", "create-connection");
    expect(connections.length).toBeGreaterThan(0);
    expect(flag(connections[0] ?? [], "--auth-parameters")).toContain(
      `ApiKeyValue=${match?.[1]}`,
    );
  });

  it("fails when put-targets smuggles its failure in the body as a FailedEntryCount", async () => {
    // The CLI exits 0 for this; only the body says the rule was left with NO
    // target. Swallowing it is an ENABLED rule delivering nothing, forever.
    const result = await run({ secret: "shared-secret", targetFailures: 1 });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("put-targets");
    expect(result.stderr).toContain("failed entry");
  });

  it("stops on a probe error it cannot read as not-found, rather than deciding on a fact it never learned", async () => {
    // AccessDenied on describe-connection is NOT "the connection is absent".
    // Reading it as absent would mint a new secret over a live one and then
    // try to create resources that already exist.
    const result = await run({ awsFail: "events:describe-connection" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("AccessDenied");
    expect(callsFor(result, "events", "create-connection")).toHaveLength(0);
    expect(callsFor(result, "iam", "create-role")).toHaveLength(0);
    expect(callsFor(result, "sns")).toHaveLength(0);
  });
});
