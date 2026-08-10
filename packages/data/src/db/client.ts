/**
 * Database connection.
 *
 * A single pooled client shared by the worker and the web app. The pool is
 * created lazily so importing the schema (for types, or in tests) does not open
 * a connection.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  readonly connectionString?: string;
  /**
   * Pool size. The worker runs a single scan at a time and the web app only
   * reads, so a small pool is ample; oversizing it mainly risks exhausting
   * Postgres connections during development.
   */
  readonly max?: number;
}

let pool: pg.Pool | null = null;
let database: Database | null = null;

export function connectionStringFromEnv(): string {
  const url = process.env.DATABASE_URL;
  if (url && url.length > 0) return url;
  return 'postgres://stealth:stealth@localhost:5432/stealth';
}

/** Returns the shared database handle, creating the pool on first use. */
export function getDatabase(options: DatabaseOptions = {}): Database {
  if (database !== null) return database;

  pool = new pg.Pool({
    connectionString: options.connectionString ?? connectionStringFromEnv(),
    max: options.max ?? 10,
  });

  database = drizzle(pool, { schema });
  return database;
}

/** Closes the pool. Call on worker shutdown; tests use it to avoid open handles. */
export async function closeDatabase(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
    database = null;
  }
}

export { schema };
