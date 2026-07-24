import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import "dotenv/config";

// This pool is used by the API and worker at runtime. It MUST connect as
// the restricted `app_user` role created in migration 0005, not as the
// table-owning/admin role used to run migrations — RLS policies have no
// effect on the owning role unless connections go through app_user.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Runs `fn` inside a transaction with the Postgres session variable
 * `app.current_account_id` set to the given account id. Row-Level
 * Security policies on tenant tables key off this variable, so this
 * is the ONLY sanctioned way application code should touch
 * account-scoped tables (contacts, audiences, campaigns, ...).
 *
 * `SET LOCAL` scopes the setting to the current transaction, so it
 * can never leak onto a pooled connection reused by a different
 * request.
 */
export async function withAccountScope<T>(
  accountId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_account_id', $1, true)", [accountId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * For queries that are genuinely account-independent (e.g. looking up
 * a user row by email during login, before we know the account).
 * Do NOT use this for contacts/audiences/campaigns/etc.
 */
export async function queryUnscoped<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}
