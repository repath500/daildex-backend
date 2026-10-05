import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const sample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const configured = sample.replace(/=replace-with-random-secret/g, () => `=${randomBytes(32).toString("hex")}`);
try {
  await writeFile(new URL("../.env.local", import.meta.url), configured, { flag: "wx", mode: 0o600 });
  console.log("Created .env.local with fresh local tokens. Existing environments are never overwritten.");
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  console.log(".env.local already exists; kept your configuration.");
}
