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

    if (this.journeys.has(validated.id)) {
      throw new Error(
        `Journey id collision: "${validated.id}" is registered by more than one journey (check your journeys[] array for two journeys sharing this id, or a journey id that duplicates a bucket-reaction id).`,
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
