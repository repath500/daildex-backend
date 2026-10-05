import postgres from "postgres";

export type Database = ReturnType<typeof postgres>;
export type TransactionDatabase = postgres.TransactionSql;
export type JsonValue = postgres.JSONValue;

let database: Database | null = null;

export function getDatabase(): Database {
  if (database) return database;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  database = postgres(databaseUrl, {
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    transform: { undefined: null },
  });

  return database;
}

export async function closeDatabase(): Promise<void> {
  if (!database) return;
  await database.end({ timeout: 5 });
  database = null;
}
