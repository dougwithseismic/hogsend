export interface DurationObject {
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
}

export function days(n: number): DurationObject {
  return { hours: n * 24 };
}

export function hours(n: number): DurationObject {
  return { hours: n };
}

export function minutes(n: number): DurationObject {
  return { minutes: n };
}
