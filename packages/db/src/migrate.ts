import { createHash } from "node:crypto";
import postgres from "postgres";
import { migrations } from "./migrations";

export async function migrate(databaseUrl: string): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const applied: string[] = [];

  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await sql.unsafe(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`);

    await sql`SELECT pg_advisory_lock(hashtext('daildex_schema_migrations'))`;
    try {
      for (const migration of migrations) {
        const checksum = createHash("sha256").update(migration.sql).digest("hex");
        const existing = await sql<{ id: string; checksum: string | null }[]>`
          SELECT id, checksum FROM schema_migrations WHERE id = ${migration.id}
        `;
        if (existing[0]) {
          if (existing[0].checksum && existing[0].checksum !== checksum) {
            throw new Error(`Applied migration ${migration.id} has changed`);
          }
          if (!existing[0].checksum) {
            await sql`UPDATE schema_migrations SET checksum = ${checksum} WHERE id = ${migration.id}`;
          }
          continue;
        }

        await sql.begin(async (transaction) => {
          await transaction.unsafe(migration.sql);
          await transaction`
            INSERT INTO schema_migrations (id, checksum) VALUES (${migration.id}, ${checksum})
          `;
        });
        applied.push(migration.id);
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext('daildex_schema_migrations'))`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  return applied;
}

export async function findPendingMigrations(databaseUrl: string): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const table = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists
    `;
    if (!table[0]?.exists) return migrations.map((migration) => migration.id);

    const rows = await sql<{ id: string }[]>`SELECT id FROM schema_migrations`;
    const applied = new Set(rows.map((row) => row.id));
    return migrations.filter((migration) => !applied.has(migration.id)).map((migration) => migration.id);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
