import { migrate } from "../migrate";

const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL_UNPOOLED;
if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL is not configured");

const applied = await migrate(databaseUrl);
console.log(applied.length === 0 ? "Database is current." : `Applied: ${applied.join(", ")}`);
