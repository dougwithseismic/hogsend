import { createDatabase, type Database } from "@hogsend/db";

let _db: Database | undefined;

export function getDb(): Database {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    const { db } = createDatabase({ url });
    _db = db;
  }
  return _db;
}
