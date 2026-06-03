import type { BucketRegistry } from "@hogsend/core/registry";

let _registry: BucketRegistry | undefined;

export function setBucketRegistry(registry: BucketRegistry): void {
  _registry = registry;
}

export function getBucketRegistrySingleton(): BucketRegistry {
  if (!_registry) {
    throw new Error(
      "Bucket registry not initialized. Call setBucketRegistry() at startup.",
    );
  }
  return _registry;
}

/** Reset the singleton — only for test cleanup. */
export function resetBucketRegistry(): void {
  _registry = undefined;
}
