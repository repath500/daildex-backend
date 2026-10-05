import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "@daildex/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestPolicyManifest } from "./policy";

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("reviewed policy ingestion", () => {
  const database = process.env.DATABASE_URL ? getDatabase() : null!;
  const sourceUrl = "https://example.test/integration-policy";
  const partySourceUri = `https://example.test/party/${randomUUID()}`;
  let directory = "";
  let path = "";
  let partyName = "";

  beforeAll(async () => {
    partyName = `Integration Party ${randomUUID()}`;
    await database`INSERT INTO parties (source_uri, name) VALUES (${partySourceUri}, ${partyName})`;
    directory = await mkdtemp(join(tmpdir(), "daildex-policy-"));
    path = join(directory, "manifest.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      documents: [{
        partyName,
        sourceType: "policy_paper",
        sourceOwner: "Integration fixture",
        rightsBasis: "Integration fixture only",
        title: "Integration policy",
        sourceUrl,
        reviewedAt: "2026-07-06T00:00:00Z",
        sections: [{
          topicTag: "housing",
          heading: "Housing fixture",
          text: "This reviewed integration fixture describes a housing supply policy in sufficient detail.",
        }],
      }],
    }));
  });

  afterAll(async () => {
    await database`DELETE FROM policy_documents WHERE source_url = ${sourceUrl}`;
    await database`DELETE FROM parties WHERE source_uri = ${partySourceUri}`;
    if (directory) await rm(directory, { recursive: true, force: true });
    await closeDatabase();
  });

  it("is idempotent and retains exact reviewed source metadata", async () => {
    await expect(ingestPolicyManifest(path, database)).resolves.toEqual({ seen: 1, written: 1 });
    await expect(ingestPolicyManifest(path, database)).resolves.toEqual({ seen: 1, written: 1 });
    const rows = await database<{ documents: number; chunks: number }[]>`
      SELECT count(DISTINCT document.id)::INTEGER AS documents, count(chunk.id)::INTEGER AS chunks
      FROM policy_documents document
      LEFT JOIN policy_chunks chunk ON chunk.policy_document_id = document.id
      WHERE document.source_url = ${sourceUrl}
    `;
    expect(rows[0]).toEqual({ documents: 1, chunks: 1 });
  }, 15_000);
});
