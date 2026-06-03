import { bucketMetaSchema } from "../schemas/index.js";
import type { BucketMeta, ConditionEval } from "../types/index.js";

/**
 * Walk a ConditionEval tree, collecting every EventCondition.eventName. Pure
 * tree walk over the discriminated union, mirroring core/conditions/event.ts.
 */
export function collectEventNames(criteria: ConditionEval): string[] {
  const names: string[] = [];
  const visit = (condition: ConditionEval): void => {
    switch (condition.type) {
      case "event":
        names.push(condition.eventName);
        break;
      case "composite":
        for (const child of condition.conditions) {
          visit(child);
        }
        break;
      default:
        break;
    }
  };
  visit(criteria);
  return names;
}

/**
 * Walk a ConditionEval tree, collecting every PropertyCondition.property. Pure
 * tree walk over the discriminated union.
 */
export function collectPropertyNames(criteria: ConditionEval): string[] {
  const names: string[] = [];
  const visit = (condition: ConditionEval): void => {
    switch (condition.type) {
      case "property":
        names.push(condition.property);
        break;
      case "composite":
        for (const child of condition.conditions) {
          visit(child);
        }
        break;
      default:
        break;
    }
  };
  visit(criteria);
  return names;
}

export class BucketRegistry {
  private buckets: Map<string, BucketMeta> = new Map();
  private eventIndex: Map<string, BucketMeta[]> = new Map();
  private propertyIndex: Map<string, BucketMeta[]> = new Map();
  // degenerate: criteria reference neither a concrete event nor any property
  private wildcard: BucketMeta[] = [];

  register(bucket: BucketMeta): void {
    const parsed = bucketMetaSchema.parse(bucket);
    const validated = parsed as unknown as BucketMeta;

    this.buckets.set(validated.id, validated);

    // manual buckets are not criteria-driven → not indexed for real-time eval
    if (validated.kind === "manual" || !validated.criteria) {
      return;
    }

    const events = collectEventNames(validated.criteria);
    const props = collectPropertyNames(validated.criteria);

    for (const eventName of events) {
      const existing = this.eventIndex.get(eventName) ?? [];
      existing.push(validated);
      this.eventIndex.set(eventName, existing);
    }

    for (const propName of props) {
      const existing = this.propertyIndex.get(propName) ?? [];
      existing.push(validated);
      this.propertyIndex.set(propName, existing);
    }

    // "*" ONLY for criteria referencing neither a concrete event nor a property
    // (degenerate; rare under the at-least-one-positive rule).
    if (events.length === 0 && props.length === 0) {
      this.wildcard.push(validated);
    }
  }

  get(id: string): BucketMeta | undefined {
    return this.buckets.get(id);
  }

  getByReferencedEvent(eventName: string): BucketMeta[] {
    return [...(this.eventIndex.get(eventName) ?? []), ...this.wildcard];
  }

  getByReferencedProperty(propName: string): BucketMeta[] {
    return this.propertyIndex.get(propName) ?? [];
  }

  getAll(): BucketMeta[] {
    return Array.from(this.buckets.values());
  }

  getEnabled(): BucketMeta[] {
    return this.getAll().filter((b) => b.enabled);
  }

  has(id: string): boolean {
    return this.buckets.has(id);
  }

  count(): number {
    return this.buckets.size;
  }
}
