import pg from "pg";

export type Pool = pg.Pool;

export function createPool(connectionString: string): Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
