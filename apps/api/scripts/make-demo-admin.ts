/**
 * Throwaway Studio admin for the agent-panel demo. Uses the engine's supported
 * createAdminUser (better-auth internal adapter, scrypt hash — no raw SQL) and a
 * unique email so it never collides with existing users in a shared dev DB.
 */

import { createHogsendClient } from "@hogsend/engine";
import { createAdminUser } from "@hogsend/engine/create-admin";

const email = "cc-agent-demo@local.test";
const password = "DemoAgent!2026";

const client = createHogsendClient();
try {
  const admin = await createAdminUser({
    auth: client.auth,
    email,
    password,
    name: "Agent Demo",
  });
  console.log(`CREATED ${admin.email}`);
} catch (e) {
  console.log(`SKIP ${(e as Error).name}: ${(e as Error).message}`);
}
process.exit(0);
