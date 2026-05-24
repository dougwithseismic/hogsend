import { journeyDefinitionSchema } from "../schemas/index.js";
import type { JourneyDefinition } from "../types/index.js";

export class JourneyRegistry {
  private journeys: Map<string, JourneyDefinition> = new Map();
  private triggerIndex: Map<string, JourneyDefinition[]> = new Map();

  register(journey: JourneyDefinition): void {
    const parsed = journeyDefinitionSchema.parse(journey);
    const validated = parsed as unknown as JourneyDefinition;

    this.journeys.set(validated.id, validated);

    const event = validated.trigger.event;
    const existing = this.triggerIndex.get(event) ?? [];
    existing.push(validated);
    this.triggerIndex.set(event, existing);
  }

  get(id: string): JourneyDefinition | undefined {
    return this.journeys.get(id);
  }

  getByTriggerEvent(eventName: string): JourneyDefinition[] {
    return this.triggerIndex.get(eventName) ?? [];
  }

  getAll(): JourneyDefinition[] {
    return Array.from(this.journeys.values());
  }

  getEnabled(): JourneyDefinition[] {
    return this.getAll().filter((j) => j.enabled);
  }

  has(id: string): boolean {
    return this.journeys.has(id);
  }

  count(): number {
    return this.journeys.size;
  }
}
