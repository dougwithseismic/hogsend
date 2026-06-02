import { sql } from "drizzle-orm";

// Shared SQL building blocks for the admin metrics + reporting routers.

/** Guarded divide, rounded to 4 decimal places. Returns 0 when denom <= 0. */
export const rate = (num: number, denom: number) =>
  denom > 0 ? Math.round((num / denom) * 10000) / 10000 : 0;

/** `date_trunc` granularity literals, keyed by the API's period/granularity enum. */
export const TRUNC_SQL = {
  hour: sql`'hour'`,
  day: sql`'day'`,
  week: sql`'week'`,
  month: sql`'month'`,
} as const;

export type TruncPeriod = keyof typeof TRUNC_SQL;
