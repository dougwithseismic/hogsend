/**
 * Tiny process-singletons: a value set once by `createHogsendClient` at startup
 * and read by module-level task-execution sites that have no client reference of
 * their own (journey/bucket durable tasks, the send-email task). Replaces the
 * hand-rolled `let _x` + set/get/reset trios that were copied across the engine.
 *
 * Two variants:
 * - `createSingleton` — required: `get()` throws if read before it is set.
 * - `createOptionalSingleton` — `undefined` is a legitimate value (e.g. analytics
 *   with no `POSTHOG_API_KEY`); `get()` returns `T | undefined` and never throws.
 */

export interface Singleton<T> {
  set(value: T): void;
  get(): T;
  reset(): void;
}

export interface OptionalSingleton<T> {
  set(value: T | undefined): void;
  get(): T | undefined;
  reset(): void;
}

export function createSingleton<T>(name: string): Singleton<T> {
  let value: T | undefined;
  return {
    set(next: T): void {
      value = next;
    },
    get(): T {
      if (value === undefined) {
        throw new Error(`${name} not initialized. Call its setter at startup.`);
      }
      return value;
    },
    reset(): void {
      value = undefined;
    },
  };
}

export function createOptionalSingleton<T>(): OptionalSingleton<T> {
  let value: T | undefined;
  return {
    set(next: T | undefined): void {
      value = next;
    },
    get(): T | undefined {
      return value;
    },
    reset(): void {
      value = undefined;
    },
  };
}
