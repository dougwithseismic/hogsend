import { eq } from "drizzle-orm";
import type { CloudDb } from "../../../src/db";
import {
  environments,
  organizations,
  sesTenants,
  stacks,
} from "../../../src/db/schema";
import { encryptSecretPayload } from "../../../src/lib/crypto";
import type { SesRegion } from "../../../src/ses/types";
import type { SubstrateRegion } from "../../../src/substrate/types";
import type { ProofNames } from "./naming";

/**
 * The run-scoped control-plane rows that make the signed instance hop real
 * (the `stub-instance.ts` design call, database side).
 *
 * `resolveTenant` (`services/email-events.ts`) joins `ses_tenants` → `stacks`
 * by environment, so an event only travels the hop when THIS exact chain
 * exists: organization → environment → stack (whose `substrateRefs` carries
 * the stub's `apiPublicUrl`) → SES tenancy (whose encrypted secret signs the
 * hop). The rows are written through the same schema production writes, not a
 * fixture shortcut, so a schema change that would break provisioning breaks
 * this proof too.
 *
 * Two facts a live operator must know, encoded here rather than in a wiki:
 *
 *  - the webhook secret is encrypted with the SCRIPT's
 *    `CLOUD_ENCRYPTION_SECRET`, and the CONTROL PLANE decrypts it — the two
 *    processes must share that env var (dev's default matches by default);
 *  - teardown is ONE delete, of the organization: every other row —
 *    environment, stack, tenancy, and the run's own `email_events` — goes with
 *    it by `onDelete: cascade`. The report is the record; the tables are left
 *    as they were found.
 */

export async function registerProofStack(
  db: CloudDb,
  input: {
    names: ProofNames;
    region: SubstrateRegion;
    awsRegion: SesRegion;
    /** The REAL tenant ARN `createTenant` returned — never derived here. */
    tenantArn: string;
    /** The stub instance's loopback URL. */
    instanceUrl: string;
    webhookSecret: string;
  },
): Promise<void> {
  const { names } = input;
  await db.insert(organizations).values({
    id: names.organizationId,
    name: `SES delivery proof ${names.runId}`,
    region: input.region,
  });
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId: names.organizationId,
      name: names.environmentId,
      kind: "test",
    })
    .returning({ id: environments.id });
  if (!environment) {
    throw new Error("the proof environment row was not created");
  }
  await db.insert(stacks).values({
    organizationId: names.organizationId,
    environmentId: environment.id,
    region: input.region,
    status: "running",
    substrateRefs: {
      substrate: "fake",
      apiPublicUrl: input.instanceUrl,
      data: {},
    },
  });
  await db.insert(sesTenants).values({
    environmentId: environment.id,
    tenantName: names.tenantName,
    tenantArn: input.tenantArn,
    configurationSetName: names.configurationSetName,
    region: input.region,
    awsRegion: input.awsRegion,
    webhookSecretEncrypted: encryptSecretPayload(input.webhookSecret),
    available: true,
  });
}

/** One delete; the cascades take the environment, stack, tenancy and the
 * run's event rows with it. */
export async function unregisterProofStack(
  db: CloudDb,
  organizationId: string,
): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, organizationId));
}
