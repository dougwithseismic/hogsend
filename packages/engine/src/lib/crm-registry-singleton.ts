import type { CrmStageMap } from "@hogsend/core";
import type { CrmProviderRegistry } from "./crm-provider-registry.js";
import { createOptionalSingleton } from "./singleton.js";

/**
 * Process singleton for the CRM sync layer — set by `createHogsendClient`
 * (both API and worker call it), read by the `crm-reconcile` cron task which
 * has no client reference. Optional: a deploy with no CRM providers leaves it
 * unset and the cron no-ops.
 */
export interface CrmSyncConfig {
  registry: CrmProviderRegistry;
  stageMaps: Record<string, CrmStageMap>;
}

const singleton = createOptionalSingleton<CrmSyncConfig>();

export const setCrmSyncConfig = singleton.set;
export const getCrmSyncConfig = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetCrmSyncConfig = singleton.reset;
