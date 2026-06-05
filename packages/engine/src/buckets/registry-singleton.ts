import type { BucketRegistry } from "@hogsend/core/registry";
import { createSingleton } from "../lib/singleton.js";

const singleton = createSingleton<BucketRegistry>("Bucket registry");

export const setBucketRegistry = singleton.set;
export const getBucketRegistrySingleton = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetBucketRegistry = singleton.reset;
