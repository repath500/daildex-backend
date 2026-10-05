import { findPendingMigrations } from "../migrate";

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED;
if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL is not configured");

const pending = await findPendingMigrations(databaseUrl);
if (pending.length > 0) {
  console.error(`Pending migrations: ${pending.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("Database migrations are current.");
}
