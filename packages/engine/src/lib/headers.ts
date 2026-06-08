/**
 * Flatten a `Headers` instance into a plain lowercased `Record<string, string>`.
 * Webhook routes verify signatures over the EXACT received bytes, so they need a
 * case-insensitive header lookup — this is the single place that lowercasing
 * lives. Pass `c.req.raw.headers`.
 */
export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    record[key.toLowerCase()] = value;
  }
  return record;
}
