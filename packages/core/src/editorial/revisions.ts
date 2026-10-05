import { randomUUID } from "node:crypto";
import { getDatabase, type Database, type JsonValue } from "@daildex/db";
import { EDITORIAL_STORY_KINDS, editorialStoryKey, editorialFinalSchema, editorialFeaturedNames, evaluateEditorialQuality, normalizeEditorialUrl, parseStoredEditorialContent,
  validateEditorialFinal, type EditorialFinal, type EditorialStoryCandidate } from "@daildex/shared";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type StoredEditorialIdentity = { storyKey: string; subject: string; normalizedSubject: string | null; storyKind: string | null;
  storyOrigin: string | null; sourceKey: string | null; participantNames: string[]; periodStart: string; periodEnd: string };

/** Recover legacy national candidates only when the stored identity proves the original event date. */
export function recoverLegacyEditorialCandidate(row: StoredEditorialIdentity, content: EditorialFinal): EditorialStoryCandidate | null {
  if (!row.normalizedSubject || !EDITORIAL_STORY_KINDS.includes(row.storyKind as EditorialStoryCandidate["kind"])) return null;
  const origins = ["government", "public_body", "party", "judicial", "eu", "reported"];
  if (!row.storyOrigin || !origins.includes(row.storyOrigin)) return null;
  const start = Date.parse(`${row.periodStart}T00:00:00Z`) - 7 * 86_400_000;
  const end = Date.parse(`${row.periodEnd}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 35 * 86_400_000) return null;
  let occurredOn: string | null = null;
  for (let day = start; day <= end; day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (editorialStoryKey(row.storyKind!, row.normalizedSubject, date) === row.storyKey) { occurredOn = date; break; }
  }
  if (!occurredOn) return null;
  const sources = content.sources.map(({ url, publisher, kind }) => ({ url, publisher, kind }));
  return { storyKey: row.storyKey, subject: row.subject, normalizedSubject: row.normalizedSubject, occurredOn,
    kind: row.storyKind as EditorialStoryCandidate["kind"], origin: row.storyOrigin as EditorialStoryCandidate["origin"],
    sourceKey: row.sourceKey, outcome: null, primaryUrls: sources.filter((source) => source.kind === "official" || source.kind === "originator"),
    reportingUrls: sources.filter((source) => source.kind === "reporting"), participants: (row.participantNames ?? []).map((name) => ({ name, party: null, participation: "reported" })),
    discoveredFrom: [], score: 0 };
}

export async function requestEditorialRevision(postId: string, kind: "update" | "correction", reason: string, actor: string, database: Database = getDatabase(), candidate?: EditorialStoryCandidate) {
  if (!reason.trim() || reason.length > 1000 || !["update", "correction"].includes(kind)) throw new Error("A revision needs a valid kind and a clear reason.");
  const rows = await database<{ id: string }[]>`
    INSERT INTO editorial_revision_requests (post_id, kind, reason, requested_by, expected_updated_at, metadata)
    SELECT id, ${kind}, ${reason.trim()}, ${actor}, COALESCE(updated_at, published_at),
      ${database.json(candidate ? JSON.parse(JSON.stringify({ candidate: { ...candidate, passages: undefined } })) as JsonValue : {})}
    FROM editorial_posts WHERE id = ${postId} AND status = 'published'
    ON CONFLICT (post_id) WHERE status IN ('queued', 'running', 'needs_review') DO NOTHING RETURNING id
  `;
  return rows[0]?.id ?? null;
}

export type ClaimedEditorialRevision = {
  id: string; postId: string; leaseToken: string; kind: "update" | "correction"; reason: string;
  periodStart: string; periodEnd: string; candidate: EditorialStoryCandidate | null; content: EditorialFinal;
  storyKey: string; subject: string;
};

export async function claimEditorialRevision(database: Database = getDatabase()): Promise<ClaimedEditorialRevision | null> {
  const token = randomUUID();
  return database.begin(async (transaction) => {
    await transaction`UPDATE editorial_revision_requests SET status = 'failed',
      error = 'Revision research exhausted its retry limit', finished_at = now()
      WHERE status = 'running' AND locked_at < now() - interval '30 minutes' AND attempts >= 3`;
    const rows = await transaction<Array<StoredEditorialIdentity & { id: string; postId: string; kind: "update" | "correction"; reason: string;
      candidate: EditorialStoryCandidate | null; content: unknown }>>`
      WITH next AS (
        SELECT id FROM editorial_revision_requests
        WHERE status = 'queued' OR (status = 'running' AND locked_at < now() - interval '30 minutes' AND attempts < 3)
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ), claimed AS (
        UPDATE editorial_revision_requests request SET status = 'running', locked_at = now(), lease_token = ${token}::uuid,
          attempts = attempts + 1, error = NULL
        FROM next WHERE request.id = next.id
        RETURNING request.*
      )
      SELECT claimed.id, claimed.post_id AS "postId", claimed.kind, claimed.reason,
        post.period_start::text AS "periodStart", post.period_end::text AS "periodEnd", post.content,
        COALESCE(claimed.metadata->'candidate', post.model_metadata->'candidate') AS candidate, post.story_key AS "storyKey", post.subject,
        post.normalized_subject AS "normalizedSubject", post.story_kind AS "storyKind", post.story_origin AS "storyOrigin",
        post.source_key AS "sourceKey", post.participant_names AS "participantNames"
      FROM claimed JOIN editorial_posts post ON post.id = claimed.post_id
    `;
    if (!rows[0]) return null;
    const content = parseStoredEditorialContent(rows[0].content);
    if (!content) {
      await transaction`UPDATE editorial_revision_requests SET status = 'failed', error = 'Stored article is unreadable', finished_at = now() WHERE id = ${rows[0].id}`;
      return null;
    }
    return { ...rows[0], content, candidate: rows[0].candidate ?? recoverLegacyEditorialCandidate(rows[0], content), leaseToken: token };
  });
}

export async function saveEditorialRevisionDraft(request: ClaimedEditorialRevision, story: EditorialStoryCandidate,
  generated: { output: unknown; observedUrls: ReadonlySet<string>; fetchedPages: ReadonlyMap<string, string>; model: string; promptVersion: string; researchBrief: unknown; evidenceFingerprint: string; sourceFingerprints?: Record<string, string> },
  database: Database = getDatabase()) {
  const result = validateEditorialFinal({ story, output: generated.output, observedUrls: generated.observedUrls,
    fetchedPages: generated.fetchedPages, periodStart: request.periodStart, periodEnd: request.periodEnd });
  const payload = JSON.parse(JSON.stringify({ model: generated.model, promptVersion: generated.promptVersion,
    researchBrief: generated.researchBrief, evidenceFingerprint: generated.evidenceFingerprint,
    sourceFingerprints: generated.sourceFingerprints ?? {},
    quality: result.valid ? evaluateEditorialQuality(result.post) : null, candidate: { ...story, passages: undefined } })) as JsonValue;
  const saved = await database<{ id: string }[]>`
    UPDATE editorial_revision_requests SET status = ${result.valid ? "needs_review" : "failed"},
      draft = ${database.json(JSON.parse(JSON.stringify(generated.output)) as JsonValue)}, metadata = ${database.json(payload)},
      error = ${result.valid ? null : result.issues.join("; ").slice(0, 3000)}, finished_at = now()
    WHERE id = ${request.id} AND status = 'running' AND lease_token = ${request.leaseToken}::uuid RETURNING id
  `;
  if (!saved.length) throw new Error("Revision research lost its lease. Its draft was not saved.");
  return result.valid;
}

export async function failEditorialRevision(request: ClaimedEditorialRevision, error: string, database: Database = getDatabase()) {
  await database`UPDATE editorial_revision_requests SET status = 'failed', error = ${error.slice(0, 3000)}, finished_at = now()
    WHERE id = ${request.id} AND status = 'running' AND lease_token = ${request.leaseToken}::uuid`;
}

export async function reviewEditorialRevision(id: string, decision: "approved" | "rejected", note: string, actor: string, database: Database = getDatabase()) {
  if (!note.trim() || note.length > 1000) throw new Error("A public update or correction note is required.");
  return database.begin(async (transaction) => {
    const requests = await transaction<Array<{ postId: string; kind: "update" | "correction"; draft: unknown; expectedUpdatedAt: Date; metadata: JsonValue }>>`
      SELECT post_id AS "postId", kind, draft, expected_updated_at AS "expectedUpdatedAt", metadata
      FROM editorial_revision_requests WHERE id = ${id} AND status = 'needs_review' FOR UPDATE
    `;
    const request = requests[0];
    if (!request) throw new Error("This revision is no longer awaiting review.");
    if (decision === "rejected") {
      await transaction`UPDATE editorial_revision_requests SET status = 'rejected', error = ${note}, finished_at = now() WHERE id = ${id}`;
      return;
    }
    if (decision !== "approved") throw new Error("Invalid revision decision.");
    const post = editorialFinalSchema.parse(request.draft);
    if (!post.verification.passed || evaluateEditorialQuality(post).issues.length) throw new Error("Revision does not pass editorial checks.");
    const rows = await transaction<Array<{ content: JsonValue; updatedAt: Date; participantNames: string[] }>>`
      SELECT post.content, post.participant_names AS "participantNames", COALESCE(post.updated_at, post.published_at) AS "updatedAt" FROM editorial_posts post
      JOIN editorial_revision_requests request ON request.post_id = post.id
      WHERE request.id = ${id} AND post.status = 'published'
        AND COALESCE(post.updated_at, post.published_at) = request.expected_updated_at FOR UPDATE OF post
    `;
    if (!rows[0] || rows[0].updatedAt.getTime() !== request.expectedUpdatedAt.getTime()) throw new Error("The article changed after this revision was requested. Reject this stale draft and request a fresh revision.");
    const candidate = asObject(asObject(request.metadata).candidate);
    const names = Array.isArray(candidate.participants) ? candidate.participants.flatMap((person: unknown) => {
      const name = asObject(person).name;
      return typeof name === "string" ? [name] : [];
    }) : [];
    const participantNames = editorialFeaturedNames(post, [...(rows[0].participantNames ?? []), ...names]);
    const content = JSON.parse(JSON.stringify(post)) as JsonValue;
    await transaction`INSERT INTO editorial_post_revisions (request_id, post_id, kind, note, reviewed_by, previous_content, content)
      VALUES (${id}, ${request.postId}, ${request.kind}, ${note.trim()}, ${actor}, ${transaction.json(rows[0].content)}, ${transaction.json(content)})`;
    await transaction`UPDATE editorial_posts SET title = ${post.title}, description = ${post.description}, content = ${transaction.json(content)},
      source_urls = ${transaction.json(post.sources.map((source) => source.url))}, verification = ${transaction.json(post.verification)},
      model_metadata = model_metadata || ${transaction.json(request.metadata)}, participant_names = ${transaction.json(participantNames)},
      source_checked_at = now(), updated_at = now() WHERE id = ${request.postId}`;
    await transaction`UPDATE editorial_revision_requests SET status = 'published', finished_at = now() WHERE id = ${id}`;
  });
}

export async function listEditorialRevisionNotes(postId: string, database: Database = getDatabase()) {
  const rows = await database<Array<{ kind: "update" | "correction"; note: string; createdAt: Date }>>`
    SELECT kind, note, created_at AS "createdAt" FROM editorial_post_revisions WHERE post_id = ${postId} ORDER BY created_at DESC LIMIT 30
  `;
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function reconsiderPublishedEditorialStories(candidates: readonly EditorialStoryCandidate[], database: Database = getDatabase(),
  probe?: (story: EditorialStoryCandidate, urls: readonly string[]) => Promise<Record<string, string> | null>) {
  if (!candidates.length) return;
  const rows = await database<Array<{ id: string; storyKey: string; content: unknown; metadata: { sourceFingerprints?: Record<string, string> } }>>`
    SELECT id, story_key AS "storyKey", content, model_metadata AS metadata FROM editorial_posts
    WHERE status = 'published' AND story_key = ANY(${candidates.map((story) => story.storyKey)})
  `;
  let probes = 0;
  for (const row of rows) {
    const story = candidates.find((candidate) => candidate.storyKey === row.storyKey);
    const content = parseStoredEditorialContent(row.content);
    if (!story || !content) continue;
    const known = new Set([...content.sources.map((source) => normalizeEditorialUrl(source.url)), ...Object.keys(row.metadata?.sourceFingerprints ?? {})]);
    const added = [...story.primaryUrls, ...story.reportingUrls].filter((source) => !known.has(normalizeEditorialUrl(source.url)));
    const prior = await database<{ id: string }[]>`SELECT id FROM editorial_revision_requests WHERE post_id = ${row.id}
      AND created_at > now() - interval '3 days' LIMIT 1`;
    if (prior.length) continue;
    let reason = added.length ? "New source coverage is available. Add only material, verified developments or useful context." : null;
    const fingerprints = row.metadata?.sourceFingerprints;
    if (!reason && probe && fingerprints && Object.keys(fingerprints).length && probes < 2) {
      probes += 1;
      let attempted = true;
      try {
        const current = await probe(story, Object.keys(fingerprints));
        if (current === null) attempted = false;
        // A failed read cannot establish that a source changed.
        if (current && Object.entries(fingerprints).some(([url, hash]) => current[url] && current[url] !== hash)) {
          reason = "An existing source has changed. Check for a material development or correction; preserve supported facts and avoid cosmetic rewrites.";
        }
      } catch { /* A recheck failure never blocks new-story publication. */ }
      finally {
        if (attempted) await database`UPDATE editorial_posts SET source_checked_at = now() WHERE id = ${row.id}`;
      }
    }
    // New or changed evidence triggers research and review, never automatic publication.
    if (reason) await requestEditorialRevision(row.id, "update", reason, "editorial-worker", database, story);
  }
}

/** Revisit older stories in rotation, even after they leave the discovery window. */
export async function listEditorialRefreshCandidates(database: Database = getDatabase()): Promise<EditorialStoryCandidate[]> {
  const rows = await database<Array<{ candidate: EditorialStoryCandidate }>>`
    SELECT post.model_metadata->'candidate' AS candidate FROM editorial_posts post
    WHERE post.status = 'published' AND post.published_at > now() - interval '14 days'
      AND post.model_metadata->'candidate' IS NOT NULL
      AND jsonb_typeof(post.model_metadata->'sourceFingerprints') = 'object'
      AND post.model_metadata->'sourceFingerprints' <> '{}'::jsonb
      AND (post.source_checked_at IS NULL OR post.source_checked_at < now() - interval '3 days')
      AND NOT EXISTS (SELECT 1 FROM editorial_revision_requests request WHERE request.post_id = post.id
        AND (request.status IN ('queued', 'running', 'needs_review') OR request.created_at > now() - interval '3 days'))
    ORDER BY post.source_checked_at ASC NULLS FIRST, post.published_at ASC LIMIT 2
  `;
  return rows.map((row) => row.candidate);
}

export async function getEditorialHealth(database: Database = getDatabase()) {
  const [runs, revisions, articles] = await Promise.all([
    database<Array<{ id: string; subject: string; status: string; error: string | null; startedAt: Date; payload: unknown; metadata: unknown }>>`
      SELECT id, subject, status, error, started_at AS "startedAt", pass_payload AS payload, model_metadata AS metadata
      FROM editorial_runs ORDER BY started_at DESC LIMIT 20`,
    database<Array<{ id: string; title: string; slug: string; kind: string; reason: string; status: string; error: string | null; draft: unknown; currentContent: unknown; metadata: unknown }>>`
      SELECT request.id, post.title, post.slug, request.kind, request.reason, request.status, request.error, request.draft,
        post.content AS "currentContent", request.metadata
      FROM editorial_revision_requests request JOIN editorial_posts post ON post.id = request.post_id
      ORDER BY request.created_at DESC LIMIT 30`,
    database<Array<{ id: string; title: string; slug: string; content: unknown }>>`
      SELECT id, title, slug, content FROM editorial_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 50`,
  ]);
  return { runs, revisions, articles: articles.map(({ content, ...row }) => {
    const post = parseStoredEditorialContent(content);
    return { ...row, quality: post ? evaluateEditorialQuality(post) : null };
  }) };
}
