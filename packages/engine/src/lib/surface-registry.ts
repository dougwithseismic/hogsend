import type { DefinedSurface } from "@hogsend/core";

/**
 * Surface routing for the control room (#485, P3): the ordered set of
 * `defineSurface` declarations the flow-map classifier compiles into node
 * rules. Declaration order IS precedence within the surface seam (exact events
 * and source rules resolve first-declared-wins; prefixes resolve longest-first
 * then declaration order), so insertion order is preserved. Duplicate ids
 * throw at boot — a surface id is a node id.
 */
export class SurfaceRegistry {
  private byId = new Map<string, DefinedSurface>();

  constructor(surfaces: DefinedSurface[] = []) {
    for (const surface of surfaces) {
      const id = surface.meta.id;
      if (this.byId.has(id)) {
        throw new Error(`duplicate surface id "${id}"`);
      }
      this.byId.set(id, surface);
    }
  }

  /** All surfaces in declaration order (= precedence within the seam). */
  getAll(): DefinedSurface[] {
    return [...this.byId.values()];
  }

  get(id: string): DefinedSurface | undefined {
    return this.byId.get(id);
  }

  count(): number {
    return this.byId.size;
  }
}
