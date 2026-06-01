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

export function durationToMs(d: DurationObject): number {
  return (
    (d.hours ?? 0) * 3_600_000 +
    (d.minutes ?? 0) * 60_000 +
    (d.seconds ?? 0) * 1_000
  );
}
