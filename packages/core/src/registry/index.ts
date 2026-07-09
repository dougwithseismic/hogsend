import { journeyMetaSchema } from "../schemas/index.js";
import type { JourneyMeta } from "../types/index.js";

export {
  BucketRegistry,
  collectEventNames,
  collectPropertyNames,
} from "./bucket.js";

export class JourneyRegistry {
  private journeys: Map<string, JourneyMeta> = new Map();
  private triggerIndex: Map<string, JourneyMeta[]> = new Map();

  register(journey: JourneyMeta): void {
    const parsed = journeyMetaSchema.parse(journey);
    const validated = parsed as unknown as JourneyMeta;

    // Fail fast on duplicate ids — copying a journey file and forgetting to
    // rename `meta.id` would otherwise silently shadow the first journey with
    // no signal. This mirrors the engine's loud idempotency-key collision
    // errors. Check BEFORE mutating triggerIndex so a throw leaves no partial
    // state.
    const prior = this.journeys.get(validated.id);
    if (prior) {
      throw new Error(
        `Duplicate journey id "${validated.id}". Journey ids must be unique. ` +
          `(Already registered: "${prior.name}".)`,
      );
    }

    this.journeys.set(validated.id, validated);

    const event = validated.trigger.event;
    const existing = this.triggerIndex.get(event) ?? [];
    existing.push(validated);
    this.triggerIndex.set(event, existing);
  }

  get(id: string): JourneyMeta | undefined {
    return this.journeys.get(id);
  }

  getByTriggerEvent(eventName: string): JourneyMeta[] {
    return this.triggerIndex.get(eventName) ?? [];
  }

  getAll(): JourneyMeta[] {
    return Array.from(this.journeys.values());
  }

  getEnabled(): JourneyMeta[] {
    return this.getAll().filter((j) => j.enabled);
  }

  has(id: string): boolean {
    return this.journeys.has(id);
  }

  count(): number {
    return this.journeys.size;
  }
}
