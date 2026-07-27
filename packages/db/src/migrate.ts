import "dotenv/config";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

async function ensureMigrationsTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function getMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".up.sql"))
    .sort();
}

async function up(pool: Pool) {
  await ensureMigrationsTable(pool);
  const { rows } = await pool.query("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  const files = getMigrationFiles();
  let ranAny = false;

  for (const file of files) {
    if (applied.has(file)) continue;
    ranAny = true;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    console.log(`Applying ${file} ...`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`  done.`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`  failed:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  if (!ranAny) console.log("No pending migrations.");
}

async function down(pool: Pool) {
  // Rolls back only the most recently applied migration, using the
  // matching .down.sql file (same base name).
  const { rows } = await pool.query(
    "SELECT name FROM schema_migrations ORDER BY applied_at DESC LIMIT 1"
  );
  if (rows.length === 0) {
    console.log("Nothing to roll back.");
    return;
  }
  const upFile: string = rows[0].name;
  const downFile = upFile.replace(".up.sql", ".down.sql");
  const sql = readFileSync(join(MIGRATIONS_DIR, downFile), "utf-8");
  console.log(`Reverting ${upFile} using ${downFile} ...`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("DELETE FROM schema_migrations WHERE name = $1", [upFile]);
    await client.query("COMMIT");
    console.log("  done.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("  failed:", err);
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const direction = process.argv[2];
  // Migrations run DDL (CREATE ROLE, ALTER TABLE ... FORCE RLS, etc.), so
  // they need the owning/admin connection, not the restricted app_user
  // role the API/worker use at runtime. Falls back to DATABASE_URL for
  // convenience in local dev where there's often only one role.
  const connectionString = process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL;const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  try {
    if (direction === "down") {
      await down(pool);
    } else {
      await up(pool);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
