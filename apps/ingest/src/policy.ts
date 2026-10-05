import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getDatabase, type Database } from "@daildex/db";
import { topicTagSchema } from "@daildex/shared";
import { z } from "zod";

const sectionSchema = z.object({
  topicTag: topicTagSchema,
  heading: z.string().trim().min(1).max(300),
  pageRef: z.string().trim().max(100).optional(),
  text: z.string().trim().min(20).max(20_000),
});

const documentSchema = z.object({
  partySourceUri: z.url().optional(),
  partyName: z.string().trim().min(1).max(200).optional(),
  sourceType: z.enum(["manifesto", "policy_paper", "programme_for_government", "official_statement"]),
  sourceOwner: z.string().trim().min(1).max(300),
  rightsBasis: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  sourceUrl: z.url().refine((value) => new URL(value).protocol === "https:", "Policy source must use HTTPS"),
  publishedAt: z.iso.datetime().optional(),
  effectiveDate: z.iso.date().optional(),
  reviewedAt: z.iso.datetime(),
  sections: z.array(sectionSchema).min(1).max(500),
}).refine((value) => Boolean(value.partySourceUri || value.partyName), "Policy document requires an exact party URI or name");

const manifestSchema = z.object({
  version: z.literal(1),
  documents: z.array(documentSchema).min(1).max(100),
});

export async function ingestPolicyManifest(path: string, database: Database = getDatabase()) {
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 10_000_000) throw new Error("Policy manifest exceeds 10 MB");
  const manifest = parsePolicyManifest(raw);
  let written = 0;
  for (const document of manifest.documents) {
    const parties = await database<{ id: string }[]>`
      SELECT id FROM parties
      WHERE (${document.partySourceUri ?? ""} <> '' AND source_uri = ${document.partySourceUri ?? ""})
         OR (${document.partyName ?? ""} <> '' AND lower(name) = lower(${document.partyName ?? ""}))
      LIMIT 2
    `;
    if (parties.length !== 1) throw new Error(`Policy party identity is missing or ambiguous for ${document.title}`);
    const fullText = document.sections.map((section) => `${section.heading}\n${section.text}`).join("\n\n");
    const contentHash = hash(fullText);
    await database.begin(async (transaction) => {
      const documents = await transaction<{ id: string }[]>`
        INSERT INTO policy_documents (
          party_id, source_type, title, source_url, full_text, published_at,
          content_hash, source_owner, rights_basis, reviewed_at, effective_date
        ) VALUES (
          ${parties[0]!.id}, ${document.sourceType}, ${document.title}, ${document.sourceUrl},
          ${fullText}, ${document.publishedAt ?? null}, ${contentHash}, ${document.sourceOwner},
          ${document.rightsBasis}, ${document.reviewedAt}, ${document.effectiveDate ?? null}
        )
        ON CONFLICT (source_url, content_hash) DO UPDATE SET
          title = EXCLUDED.title, full_text = EXCLUDED.full_text,
          source_owner = EXCLUDED.source_owner, rights_basis = EXCLUDED.rights_basis,
          reviewed_at = EXCLUDED.reviewed_at, effective_date = EXCLUDED.effective_date,
          last_checked_at = now()
        RETURNING id
      `;
      const stored = documents[0];
      if (!stored) throw new Error("Unable to persist policy document");
      await transaction`DELETE FROM policy_chunks WHERE policy_document_id = ${stored.id}`;
      for (const section of document.sections) {
        await transaction`
          INSERT INTO policy_chunks (
            policy_document_id, party_id, topic_tag, chunk_text,
            source_page_ref, content_hash, heading
          ) VALUES (
            ${stored.id}, ${parties[0]!.id}, ${section.topicTag}, ${section.text},
            ${section.pageRef ?? null}, ${hash(`${section.heading}\n${section.text}`)}, ${section.heading}
          )
        `;
      }
    });
    written += 1;
  }
  return { seen: manifest.documents.length, written };
}

export function parsePolicyManifest(raw: string) {
  return manifestSchema.parse(JSON.parse(raw));
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
