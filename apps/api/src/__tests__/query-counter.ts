import type { DatabaseClient } from "@hogsend/db";

/**
 * Count the SQL statements a block of engine code sends to Postgres.
 *
 * It hooks the postgres.js `debug` callback on an EXISTING client (the
 * container's `dbClient`) rather than wrapping drizzle, because the callback
 * fires once per statement put on the wire: drizzle queries, `tx.execute`
 * raw SQL, and the `begin`/`commit` a `db.transaction` issues all go through
 * it. That makes the count a round-trip count, which is the cost the PRD 09
 * budget is written in.
 *
 * postgres.js reads `options.debug` per statement from the same object the
 * client exposes as `sql.options`, so installing and removing the hook at
 * runtime is safe and affects nothing else. Only this file's client is
 * hooked: vitest runs each test file in its own module graph.
 *
 * Fire-and-forget work the block starts is part of its cost, so after the
 * block resolves the counter keeps listening until the connection has been
 * quiet for `settleMs`.
 */
export interface CountedStatement {
  sql: string;
  params: unknown[];
}

export interface QueryCount<T> {
  result: T;
  statements: CountedStatement[];
  count: number;
}

type DebugFn = (
  connection: number,
  query: string,
  parameters: unknown[],
  paramTypes: unknown[],
) => void;

interface DebuggableOptions {
  debug?: boolean | DebugFn;
}

const DRIVER_TYPE_FETCH =
  /^\s*select\s+b\.oid,\s*b\.typarray\s+from\s+pg_catalog\.pg_type\b/i;

export async function countQueries<T>(
  client: DatabaseClient,
  block: () => Promise<T>,
  opts: { settleMs?: number } = {},
): Promise<QueryCount<T>> {
  const settleMs = opts.settleMs ?? 100;
  const options = client.options as unknown as DebuggableOptions;
  const previous = options.debug;
  const statements: CountedStatement[] = [];
  let lastSeen = Date.now();

  options.debug = (_connection, query, parameters) => {
    // postgres.js reads the array type list once per NEW connection. It is
    // driver bookkeeping, not work the code under test asked for, and it
    // appears only when the pool happens to open a connection mid-block.
    if (DRIVER_TYPE_FETCH.test(query)) return;
    statements.push({ sql: query, params: [...parameters] });
    lastSeen = Date.now();
  };

  try {
    const result = await block();
    // Wait out trailing fire-and-forget statements.
    lastSeen = Date.now();
    while (Date.now() - lastSeen < settleMs) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { result, statements, count: statements.length };
  } finally {
    options.debug = previous;
  }
}

/** One statement per line, whitespace-collapsed and clipped, for messages. */
export function describeStatements(statements: CountedStatement[]): string {
  return statements
    .map(
      (s, i) =>
        `${String(i + 1).padStart(2)}. ${s.sql.replace(/\s+/g, " ").slice(0, 160)}`,
    )
    .join("\n");
}
