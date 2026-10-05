import { randomUUID } from "node:crypto";
import { getDatabase, type Database, type JsonValue } from "@daildex/db";
import {
  editorialFinalSchema,
  editorialFeaturedNames,
  parseStoredEditorialContent,
  type EditorialBrief,
  type EditorialFinal,
  type EditorialStoryCandidate,
} from "@daildex/shared";
import { listEditorialRevisionNotes } from "./revisions";
export * from "./revisions";

type RunStatus = "running" | "published" | "suppressed" | "failed";

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export async function getEditorialBrief(
  constituencyName: string,
  periodStart: string,
  periodEnd: string,
  database: Database = getDatabase(),
): Promise<EditorialBrief> {
  const rows = await database<{
    constituencyName: string;
    county: string | null;
    representativeName: string;
    party: string;
    role: string;
    area: string;
    facts: unknown;
  }[]>`
    SELECT
      constituency.name AS "constituencyName",
      constituency.county,
      representative.name AS "representativeName",
      representative.party_name AS party,
      representative.role,
      representative.area,
      COALESCE(
        json_agg(
          json_build_object(
            'factType', fact.fact_type,
            'payload', fact.fact_payload,
            'sourceUrl', fact.source_url,
            'effectiveAt', fact.effective_at
          ) ORDER BY fact.effective_at DESC
        ) FILTER (WHERE fact.id IS NOT NULL),
        '[]'::json
      ) AS facts
    FROM constituencies constituency
    JOIN representatives representative ON representative.constituency_id = constituency.id
    LEFT JOIN td_facts fact
      ON fact.representative_id = representative.id
      AND fact.effective_at >= ${periodStart}::date
      AND fact.effective_at < (${periodEnd}::date + interval '1 day')
    WHERE lower(constituency.name) = lower(${constituencyName})
      AND representative.status = 'active'
      AND representative.role = 'TD'
    GROUP BY constituency.name, constituency.county, representative.id,
      representative.name, representative.party_name, representative.role, representative.area
    ORDER BY representative.name
  `;

  const first = rows[0];
  if (!first) throw new Error(`No active TDs found for constituency: ${constituencyName}`);

  return {
    constituencyName: first.constituencyName,
    counties: [...new Set(rows.map((row) => row.county).filter((value): value is string => Boolean(value)))],
    periodStart,
    periodEnd,
    representatives: rows.map((row) => ({
      name: row.representativeName,
      party: row.party,
      role: row.role,
      area: row.area,
      facts: Array.isArray(row.facts) ? row.facts.map(normalizeFact) : [],
    })),
  };
}

function normalizeFact(value: unknown): EditorialBrief["representatives"][number]["facts"][number] {
  const fact = (value ?? {}) as Record<string, unknown>;
  return {
    factType: typeof fact.factType === "string" ? fact.factType : "unknown",
    payload: fact.payload ?? null,
    sourceUrl: typeof fact.sourceUrl === "string" ? fact.sourceUrl : null,
    effectiveAt: typeof fact.effectiveAt === "string" ? fact.effectiveAt : null,
  };
}

export async function startEditorialRun(
  story: Pick<EditorialStoryCandidate, "storyKey" | "kind" | "origin" | "subject" | "normalizedSubject" | "sourceKey"> & {
    participants?: EditorialStoryCandidate["participants"];
  },
  periodStart: string,
  periodEnd: string,
  modelMetadata: Record<string, unknown>,
  database: Database = getDatabase(),
): Promise<{ id: string; acquired: boolean; status: RunStatus }> {
  const leaseToken = randomUUID();
  const leaseMetadata = { ...modelMetadata, leaseToken };
  const rows = await database<{ id: string; status: RunStatus; acquired: boolean }[]>`
    INSERT INTO editorial_runs (
      constituency_name, period_start, period_end, status, model_metadata,
      story_key, story_kind, story_origin, subject, normalized_subject, source_key
    ) VALUES (
      ${""}, ${periodStart}::date, ${periodEnd}::date, 'running', ${database.json(toJson(leaseMetadata))},
      ${story.storyKey}, ${story.kind}, ${story.origin}, ${story.subject},
      ${story.normalizedSubject}, ${story.sourceKey}
    )
    ON CONFLICT (story_key, period_start, period_end) DO UPDATE SET
      status = CASE
        WHEN editorial_runs.status = 'published' THEN editorial_runs.status
        WHEN editorial_runs.status = 'running' AND editorial_runs.started_at > now() - interval '2 hours'
          THEN editorial_runs.status
        ELSE 'running'
      END,
      error = CASE
        WHEN editorial_runs.status = 'published' THEN editorial_runs.error
        WHEN editorial_runs.status = 'running' AND editorial_runs.started_at > now() - interval '2 hours'
          THEN editorial_runs.error
        ELSE NULL
      END,
      model_metadata = CASE
        WHEN editorial_runs.status = 'published' THEN editorial_runs.model_metadata
        WHEN editorial_runs.status = 'running' AND editorial_runs.started_at > now() - interval '2 hours'
          THEN editorial_runs.model_metadata
        ELSE EXCLUDED.model_metadata
      END,
      started_at = CASE
        WHEN editorial_runs.status = 'published' THEN editorial_runs.started_at
        WHEN editorial_runs.status = 'running' AND editorial_runs.started_at > now() - interval '2 hours'
          THEN editorial_runs.started_at
        ELSE now()
      END,
      finished_at = CASE
        WHEN editorial_runs.status = 'published' THEN editorial_runs.finished_at
        ELSE NULL
      END
    RETURNING id, status,
      status = 'running' AND model_metadata->>'leaseToken' = ${leaseToken} AS acquired
  `;
  const run = rows[0];
  if (!run) throw new Error("Could not create editorial run");
  return { id: run.id, acquired: run.acquired, status: run.status };
}

export async function finishEditorialRun(
  runId: string,
  status: Exclude<RunStatus, "running">,
  passPayload: Record<string, unknown>,
  error: string | null,
  database: Database = getDatabase(),
) {
  await database`
    UPDATE editorial_runs
    SET status = ${status}, pass_payload = ${database.json(toJson(passPayload))},
        error = ${error}, finished_at = now()
    WHERE id = ${runId}
  `;
}

export async function publishEditorialPost(
  runId: string,
  post: EditorialFinal,
  slug: string,
  modelMetadata: Record<string, unknown>,
  story: Pick<EditorialStoryCandidate, "storyKey" | "kind" | "origin" | "subject" | "normalizedSubject" | "sourceKey"> & {
    participants?: EditorialStoryCandidate["participants"];
  },
  database: Database = getDatabase(),
) {
  const parsed = editorialFinalSchema.parse(post);
  const people = await resolveEditorialParticipants(story.participants ?? [], database);
  const participantNames = editorialFeaturedNames(parsed, people.map((participant) => participant.name));
  return database.begin(async (transaction) => {
    const rows = await transaction<{ id: string }[]>`
      SELECT id
      FROM editorial_runs WHERE id = ${runId} AND status = 'running' FOR UPDATE
    `;
    if (!rows[0]) throw new Error("Editorial run is no longer active");
    const inserted = await transaction<{ id: string }[]>`
      INSERT INTO editorial_posts (
        editorial_run_id, slug, constituency_name, period_start, period_end,
        title, description, content, source_urls, verification, model_metadata,
        status, published_at, updated_at, story_key, story_kind, story_origin, subject,
        normalized_subject, source_key, participant_names, source_checked_at
      ) VALUES (
        ${runId}, ${slug}, ${""},
        ${parsed.period.start}, ${parsed.period.end}, ${parsed.title}, ${parsed.description},
        ${transaction.json(parsed)},
        ${transaction.json(parsed.sources.map((source) => source.url))},
        ${transaction.json(parsed.verification)}, ${transaction.json(toJson(modelMetadata))}, 'published', now(), now(),
        ${story.storyKey}, ${story.kind}, ${story.origin}, ${story.subject},
        ${story.normalizedSubject}, ${story.sourceKey}, ${transaction.json(participantNames)}, now()
      )
      ON CONFLICT (editorial_run_id) DO UPDATE SET
        slug = EXCLUDED.slug, title = EXCLUDED.title, description = EXCLUDED.description,
        content = EXCLUDED.content, source_urls = EXCLUDED.source_urls,
        verification = EXCLUDED.verification, model_metadata = EXCLUDED.model_metadata,
        constituency_name = '', story_key = EXCLUDED.story_key, story_kind = EXCLUDED.story_kind,
        story_origin = EXCLUDED.story_origin, subject = EXCLUDED.subject,
        normalized_subject = EXCLUDED.normalized_subject, source_key = EXCLUDED.source_key,
        participant_names = EXCLUDED.participant_names,
        source_checked_at = now(),
        status = 'published', published_at = COALESCE(editorial_posts.published_at, now()), updated_at = now()
      RETURNING id
    `;
    await transaction`
      UPDATE editorial_runs SET status = 'published',
        pass_payload = ${transaction.json(toJson({ article: parsed, generation: modelMetadata }))},
        error = NULL, finished_at = now() WHERE id = ${runId}
    `;
    return inserted[0]?.id ?? null;
  });
}

export async function resolveEditorialParticipants(participants: EditorialStoryCandidate["participants"], database: Database = getDatabase()) {
  const codes = participants.flatMap((person) => person.memberCode ? [person.memberCode] : []);
  if (!codes.length) return participants;
  const rows = await database<Array<{ name: string; code: string }>>`
    SELECT name, source_member_code AS code FROM representatives WHERE source_member_code = ANY(${codes})
  `;
  const names = new Map(rows.map((row) => [row.code, row.name]));
  return participants.map((person) => ({ ...person, name: names.get(person.memberCode ?? "") ?? person.name }));
}

/** Exact subject/source relationships only; similar wording does not establish a follow-up. */
export async function listRelatedEditorialPosts(slug: string, database: Database = getDatabase()): Promise<EditorialPostSummary[]> {
  const rows = await database<EditorialSummaryRow[]>`
    SELECT related.slug, related.title, related.description, related.period_start::text AS "periodStart",
      related.period_end::text AS "periodEnd", related.published_at AS "publishedAt", related.updated_at AS "modifiedAt",
      related.story_kind AS "storyKind", related.participant_names AS "participantNames"
    FROM editorial_posts current JOIN editorial_posts related
      ON (related.normalized_subject = current.normalized_subject OR (current.source_key IS NOT NULL AND related.source_key = current.source_key))
    WHERE current.slug = ${slug} AND related.id <> current.id AND related.status = 'published'
    ORDER BY related.published_at DESC LIMIT 5
  `;
  return rows.map(toSummary);
}

export async function getPublishedEditorialPost(slug: string, database: Database = getDatabase()) {
  const rows = await database<{
    id: string;
    slug: string;
    constituencyName: string;
    periodStart: string;
    periodEnd: string;
    title: string;
    description: string;
    content: unknown;
    publishedAt: Date;
    modifiedAt: Date | null;
    storyKind: string | null;
    participantNames: string[];
  }[]>`
    SELECT id, slug, constituency_name AS "constituencyName",
      period_start::text AS "periodStart", period_end::text AS "periodEnd",
      title, description, content, published_at AS "publishedAt",
      updated_at AS "modifiedAt", story_kind AS "storyKind",
      participant_names AS "participantNames"
    FROM editorial_posts
    WHERE slug = ${slug} AND status = 'published'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const content = parseStoredEditorialContent(row.content);
  if (!content) return null;
  return {
    ...row,
    content,
    publishedAt: row.publishedAt.toISOString(),
    modifiedAt: (row.modifiedAt ?? row.publishedAt).toISOString(),
    participantNames: Array.isArray(row.participantNames) ? row.participantNames : [],
    revisions: await listEditorialRevisionNotes(row.id, database),
  };
}

export async function listPublishedEditorialStoryKeys(database: Database = getDatabase()): Promise<string[]> {
  const rows = await database<{ storyKey: string }[]>`
    SELECT story_key AS "storyKey"
    FROM editorial_runs
    WHERE status = 'published' AND story_key IS NOT NULL
  `;
  return rows.map((row) => row.storyKey);
}

export async function listRecentEditorialSubjects(
  subjects: readonly string[],
  database: Database = getDatabase(),
): Promise<string[]> {
  if (!subjects.length) return [];
  const rows = await database<{ normalizedSubject: string }[]>`
    SELECT DISTINCT normalized_subject AS "normalizedSubject"
    FROM editorial_posts
    WHERE status = 'published'
      AND normalized_subject = ANY(${subjects})
      AND published_at >= now() - interval '30 days'
  `;
  return rows.map((row) => row.normalizedSubject).filter(Boolean);
}

export async function listEditorialSlugs(database: Database = getDatabase()): Promise<string[]> {
  const rows = await database<{ slug: string }[]>`SELECT slug FROM editorial_posts`;
  return rows.map((row) => row.slug);
}

export async function listConstituencyTdNames(
  constituencyName: string,
  database: Database = getDatabase(),
): Promise<string[]> {
  const rows = await database<{ name: string }[]>`
    SELECT representative.name
    FROM constituencies constituency
    JOIN representatives representative ON representative.constituency_id = constituency.id
    WHERE lower(constituency.name) = lower(${constituencyName})
      AND representative.status = 'active'
      AND representative.role = 'TD'
    ORDER BY representative.name
  `;
  return rows.map((row) => row.name);
}

export type EditorialPostSummary = {
  slug: string;
  title: string;
  description: string;
  periodStart: string;
  periodEnd: string;
  publishedAt: string;
  modifiedAt: string;
  storyKind: string | null;
  participantNames: string[];
};

type EditorialSummaryRow = Omit<EditorialPostSummary, "publishedAt" | "modifiedAt"> & {
  publishedAt: Date;
  modifiedAt: Date | null;
};

function toSummary(row: EditorialSummaryRow): EditorialPostSummary {
  return {
    ...row,
    publishedAt: row.publishedAt.toISOString(),
    modifiedAt: (row.modifiedAt ?? row.publishedAt).toISOString(),
    participantNames: Array.isArray(row.participantNames) ? row.participantNames : [],
  };
}

/** List published posts without their bodies, in one query. */
export async function listPublishedEditorialPosts(
  limit = 50,
  database: Database = getDatabase(),
  options: { offset?: number } = {},
): Promise<EditorialPostSummary[]> {
  const rows = await database<EditorialSummaryRow[]>`
    SELECT slug, title, description,
      period_start::text AS "periodStart", period_end::text AS "periodEnd",
      published_at AS "publishedAt", updated_at AS "modifiedAt",
      story_kind AS "storyKind", participant_names AS "participantNames"
    FROM editorial_posts
    WHERE status = 'published' AND published_at IS NOT NULL
    ORDER BY published_at DESC
    LIMIT ${Math.max(1, Math.min(limit, 1000))}
    OFFSET ${Math.max(0, options.offset ?? 0)}
  `;
  return rows.map(toSummary);
}

export async function countPublishedEditorialPosts(database: Database = getDatabase()): Promise<number> {
  const rows = await database<{ count: number }[]>`
    SELECT count(*)::int AS count FROM editorial_posts WHERE status = 'published' AND published_at IS NOT NULL
  `;
  return rows[0]?.count ?? 0;
}

/** Published posts that name any of these people, newest first. */
export async function listPublishedEditorialPostsMentioning(
  names: readonly string[],
  limit = 6,
  database: Database = getDatabase(),
): Promise<EditorialPostSummary[]> {
  if (!names.length) return [];
  const rows = await database<EditorialSummaryRow[]>`
    SELECT slug, title, description,
      period_start::text AS "periodStart", period_end::text AS "periodEnd",
      published_at AS "publishedAt", updated_at AS "modifiedAt",
      story_kind AS "storyKind", participant_names AS "participantNames"
    FROM editorial_posts
    WHERE status = 'published' AND published_at IS NOT NULL
      AND participant_names ?| ${[...names]}::text[]
    ORDER BY published_at DESC
    LIMIT ${Math.max(1, Math.min(limit, 50))}
  `;
  return rows.map(toSummary);
}

/** Stories the validator suppressed in the last few days, excluding dry runs. */
export async function listRecentlySuppressedEditorialStoryKeys(
  days = 3,
  database: Database = getDatabase(),
): Promise<string[]> {
  const rows = await database<{ storyKey: string }[]>`
    SELECT DISTINCT story_key AS "storyKey"
    FROM editorial_runs
    WHERE status = 'suppressed'
      AND story_key IS NOT NULL
      AND COALESCE(error, '') <> 'dry_run'
      AND finished_at >= now() - make_interval(days => ${Math.max(1, Math.min(days, 30))})
  `;
  return rows.map((row) => row.storyKey);
}
