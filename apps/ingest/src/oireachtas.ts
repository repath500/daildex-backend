import { createHash } from "node:crypto";
import { getDatabase, type Database, type JsonValue, type TransactionDatabase } from "@daildex/db";

type ApiPage<T> = {
  head?: { counts?: { resultCount?: number } };
  results?: T[];
};

type MemberResult = {
  member?: {
    showAs?: string;
    pId?: string;
    uri?: string;
    memberships?: Array<{
      membership?: {
        dateRange?: { start?: string; end?: string | null };
        house?: { houseCode?: string };
        parties?: Array<{ party?: { showAs?: string; uri?: string; dateRange?: { end?: string | null } } }>;
        represents?: Array<{ represent?: { showAs?: string; uri?: string } }>;
      };
    }>;
  };
};

type VoteMember = { member?: { memberCode?: string; uri?: string; showAs?: string } };
type VoteResult = {
  division?: {
    uri?: string;
    voteId?: string;
    date?: string;
    datetime?: string;
    outcome?: string;
    subject?: { showAs?: string; uri?: string | null };
    house?: { houseNo?: string; houseCode?: string };
    debate?: { showAs?: string; uri?: string };
    tallies?: {
      taVotes?: { members?: VoteMember[] };
      nilVotes?: { members?: VoteMember[] };
      staonVotes?: { members?: VoteMember[] };
    };
  };
};

type VoteTallies = NonNullable<VoteResult["division"]>["tallies"];

export type QuestionResult = {
  question?: {
    uri?: string;
    date?: string;
    questionNumber?: number;
    questionType?: string;
    showAs?: string;
    answerText?: string;
    by?: { showAs?: string; memberCode?: string; uri?: string };
    to?: { showAs?: string; uri?: string | null };
    debateSection?: {
      uri?: string;
      showAs?: string;
      debateSectionId?: string;
      formats?: { xml?: { uri?: string } | null };
    };
  };
};

type DebateSpeaker = { showAs?: string; memberCode?: string | null; uri?: string | null };
export type DebateText = { speaker?: DebateSpeaker | null; textType?: string; text?: string };
export type DebateResult = {
  debateRecord?: {
    uri?: string;
    date?: string;
    lastUpdated?: string;
    debateType?: string;
    house?: { houseCode?: string; chamberType?: string; showAs?: string };
    formats?: { xml?: { uri?: string } | null };
    debateSections?: Array<{
      debateSection?: {
        uri?: string;
        debateSectionId?: string;
        showAs?: string;
        containsDebate?: boolean;
        text?: DebateText[];
      };
    }>;
  };
};

export type LegislationResult = {
  bill?: {
    uri?: string;
    billNo?: string;
    billYear?: string;
    shortTitleEn?: string;
    longTitleEn?: string;
    status?: string;
    source?: string;
    lastUpdated?: string;
    mostRecentStage?: { event?: { showAs?: string; dates?: Array<{ date?: string }> } };
    debates?: Array<{
      uri?: string;
      debateSectionId?: string;
      date?: string;
      showAs?: string;
    }>;
    relatedDocs?: Array<{
      relatedDoc?: {
        uri?: string;
        docType?: string;
        showAs?: string;
        lang?: string;
        formats?: { pdf?: { uri?: string } | null; xml?: { uri?: string } | null };
      };
    }>;
  };
};

export type HouseCode = "dail" | "seanad";

const HOUSES: Record<HouseCode, { chamber: "Dáil" | "Seanad"; role: "TD" | "Senator"; label: string }> = {
  dail: { chamber: "Dáil", role: "TD", label: "Dáil Éireann" },
  seanad: { chamber: "Seanad", role: "Senator", label: "Seanad Éireann" },
};

/**
 * Houses to ingest. Defaults to the Dáil only; set INGEST_CHAMBERS=dail,seanad to add the Seanad once
 * the consumer site is ready to show Senators (follow pages and alerts read the same table).
 */
export function ingestChambers(value: string | undefined = process.env.INGEST_CHAMBERS): HouseCode[] {
  const requested = (value ?? "dail").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const unknown = requested.filter((entry) => entry !== "dail" && entry !== "seanad");
  if (unknown.length > 0) throw new Error(`INGEST_CHAMBERS has unknown house(s): ${unknown.join(", ")}`);
  return requested.length > 0 ? [...new Set(requested)] as HouseCode[] : ["dail"];
}

const baseUrl = (process.env.OIREACHTAS_API_BASE_URL ?? "https://api.oireachtas.ie/v1").replace(/\/$/, "");

export async function syncMembers(
  database: Database = getDatabase(),
  houses: HouseCode[] = ingestChambers(),
) {
  const runId = await startRun("oireachtas_members", database);
  let seen = 0;
  let written = 0;

  try {
    for (const house of houses) {
      const { chamber, role } = HOUSES[house];
      const results = await fetchAll<MemberResult>("/members", { chamber: house });
      for (const result of results) {
        const normalized = normalizeMember(result, house);
        if (!normalized) continue;
        seen += 1;
        // A person who sat in the Dáil and now sits in the Seanad keeps their Dáil row; the Senator gets a suffixed key.
        // A person's member code is the same in both houses, so the clash is the key being held by the other chamber.
        if (house === "seanad") {
          const clash = await database<{ chamber: string }[]>`
            SELECT chamber FROM representatives WHERE representative_key = ${normalized.key} AND chamber <> ${chamber}
          `;
          if (clash.length > 0) normalized.key = `${normalized.key}-seanad`;
        }
        const partyRows = await database<{ id: string }[]>`
          INSERT INTO parties (source_uri, name)
          VALUES (${normalized.partyUri}, ${normalized.party})
          ON CONFLICT (source_uri) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
          RETURNING id
        `;
        const constituencyRows = await database<{ id: string }[]>`
          INSERT INTO constituencies (source_uri, name)
          VALUES (${normalized.areaUri}, ${normalized.area})
          ON CONFLICT (source_uri) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
          RETURNING id
        `;
        const rows = await database`
          INSERT INTO representatives (
            representative_key, source_uri, source_member_code, name, chamber, role,
            area, party_name, party_id, constituency_id, status, raw_source
          ) VALUES (
            ${normalized.key}, ${normalized.uri}, ${normalized.memberCode}, ${normalized.name},
            ${chamber}, ${role}, ${normalized.area}, ${normalized.party}, ${partyRows[0]?.id ?? null},
            ${constituencyRows[0]?.id ?? null}, 'active', ${database.json(result)}
          )
          ON CONFLICT (representative_key) DO UPDATE SET
            source_uri = EXCLUDED.source_uri,
            source_member_code = EXCLUDED.source_member_code,
            name = EXCLUDED.name,
            area = EXCLUDED.area,
            party_name = EXCLUDED.party_name,
            party_id = EXCLUDED.party_id,
            constituency_id = EXCLUDED.constituency_id,
            status = 'active',
            raw_source = EXCLUDED.raw_source,
            updated_at = now()
          RETURNING id
        `;
        if (rows.length > 0) written += 1;
      }
    }
    await finishRun(runId, "succeeded", seen, written, null, database);
    return { seen, written };
  } catch (error) {
    await finishRun(runId, "failed", seen, written, errorMessage(error), database);
    throw error;
  }
}

export async function syncVotes(
  dateStart: string,
  dateEnd: string,
  database: Database = getDatabase(),
  houses: HouseCode[] = ingestChambers(),
) {
  const runId = await startRun("oireachtas_vote", database);
  let seen = 0;
  let written = 0;

  try {
    const results: VoteResult[] = [];
    for (const house of houses) {
      results.push(...await fetchAll<VoteResult>("/votes", {
        chamber: house,
        date_start: dateStart,
        date_end: dateEnd,
      }));
    }
    for (const result of results) {
      const division = result.division;
      if (!division) continue;
      const externalId = division.uri ?? `${division.date}:${division.house?.houseNo}:${division.voteId}`;
      if (!externalId || !division.date) continue;
      const divisionDate = division.date;
      seen += 1;
      const sourceUrl = division.debate?.uri ?? division.subject?.uri ?? division.uri ?? "https://www.oireachtas.ie";
      const dedupeHash = createHash("sha256").update(`oireachtas_vote:${externalId}`).digest("hex");
      const rawText = [division.subject?.showAs, division.debate?.showAs, division.outcome]
        .filter(Boolean)
        .join(" — ");

      await database.begin(async (transaction) => {
        const events = await transaction<{ id: string }[]>`
          INSERT INTO raw_events (
            source_type, source_external_id, source_url, raw_payload, raw_text, dedupe_hash
          ) VALUES (
            'oireachtas_vote', ${externalId}, ${sourceUrl}, ${transaction.json(result)},
            ${rawText}, ${dedupeHash}
          )
          ON CONFLICT (source_type, source_external_id) DO UPDATE SET
            source_url = EXCLUDED.source_url,
            raw_payload = EXCLUDED.raw_payload,
            raw_text = EXCLUDED.raw_text,
            fetched_at = now()
          RETURNING id
        `;
        const event = events[0];
        if (!event) return;

        const votes = flattenVotes(division.tallies).filter(
          (vote): vote is { participation: string; memberCode: string } => Boolean(vote.memberCode),
        );
        if (votes.length > 0) {
          const memberCodes = votes.map((vote) => vote.memberCode);
          const participations = votes.map((vote) => vote.participation);
          await transaction`
            INSERT INTO raw_event_targets (raw_event_id, representative_id, participation)
            SELECT ${event.id}, representative.id, vote.participation
            FROM unnest(${memberCodes}::TEXT[], ${participations}::TEXT[])
              AS vote(member_code, participation)
            JOIN representatives representative
              ON representative.source_member_code = vote.member_code
            ON CONFLICT (raw_event_id, representative_id) DO UPDATE SET
              participation = EXCLUDED.participation
          `;
          await transaction`
            INSERT INTO td_facts (
              representative_id, fact_type, fact_payload, source_url, source_event_id, effective_at
            )
            SELECT target.representative_id, 'vote',
              jsonb_build_object(
                'participation', target.participation,
                'subject', ${division.subject?.showAs ?? null}::TEXT,
                'outcome', ${division.outcome ?? null}::TEXT,
                'date', ${divisionDate}::TEXT
              ),
              ${sourceUrl}, ${event.id}, ${division.datetime ?? `${divisionDate}T00:00:00Z`}::TIMESTAMPTZ
            FROM raw_event_targets target WHERE target.raw_event_id = ${event.id}
            ON CONFLICT (representative_id, fact_type, source_event_id)
              WHERE source_event_id IS NOT NULL
            DO NOTHING
          `;
        }
      });
      written += 1;
    }
    await finishRun(runId, "succeeded", seen, written, null, database);
    return { seen, written };
  } catch (error) {
    await finishRun(runId, "failed", seen, written, errorMessage(error), database);
    throw error;
  }
}

export async function syncQuestions(
  dateStart: string,
  dateEnd: string,
  database: Database = getDatabase(),
) {
  const runId = await startRun("oireachtas_question", database);
  let seen = 0;
  let written = 0;
  try {
    const results = await fetchAll<QuestionResult>("/questions", {
      date_start: dateStart,
      date_end: dateEnd,
      show_answers: "true",
    });
    let batch: Promise<void>[] = [];
    for (const result of results) {
      const question = normalizeQuestion(result);
      if (!question) continue;
      seen += 1;
      const task = database.begin(async (transaction) => {
        const document = await upsertOfficialDocument(transaction, {
          sourceType: "oireachtas_question",
          sourceUri: question.uri,
          date: question.date,
          title: question.sectionTitle || `Parliamentary Question ${question.questionNumber ?? ""}`.trim(),
          canonicalUrl: question.sectionUri || question.uri,
          xmlUrl: question.xmlUrl,
          rawPayload: result,
        });
        const representatives = await transaction<{ id: string }[]>`
          SELECT id FROM representatives
          WHERE (${question.memberCode} <> '' AND source_member_code = ${question.memberCode})
             OR source_uri = ${question.memberUri}
          LIMIT 1
        `;
        const representative = representatives[0];
        const externalId = question.uri;
        const sourceUrl = question.sectionUri || question.uri;
        const rawText = [question.questionText, question.answerText].filter(Boolean).join("\n\n").slice(0, 100_000);
        const events = await transaction<{ id: string }[]>`
          INSERT INTO raw_events (
            source_type, source_external_id, source_url, raw_payload, raw_text,
            dedupe_hash, status, official_document_id
          ) VALUES (
            'oireachtas_question', ${externalId}, ${sourceUrl}, ${transaction.json(result)},
            ${rawText}, ${identityHash("oireachtas_question", externalId)},
            ${representative ? "pending" : "needs_review"},
            ${document.documentId}
          )
          ON CONFLICT (source_type, source_external_id) DO UPDATE SET
            source_url = EXCLUDED.source_url, raw_payload = EXCLUDED.raw_payload,
            raw_text = EXCLUDED.raw_text, official_document_id = EXCLUDED.official_document_id,
            status = CASE WHEN ${document.isCorrection} AND raw_events.status = 'processed' THEN 'needs_review' ELSE raw_events.status END,
            fetched_at = now()
          RETURNING id
        `;
        if (!representative || !events[0]) return;
        await transaction`
          INSERT INTO official_contributions (
            official_document_version_id, representative_id, source_uri, section_id,
            ordinal, contribution_type, text, content_hash, raw_payload
          ) VALUES (
            ${document.versionId}, ${representative.id}, ${question.uri}, ${question.sectionId ?? null},
            0, 'question', ${question.questionText}, ${textHash(question.questionText)},
            ${transaction.json({ by: result.question?.by, questionNumber: question.questionNumber })}
          ) ON CONFLICT DO NOTHING
        `;
        await transaction`
          INSERT INTO raw_event_targets (raw_event_id, representative_id, participation, status)
          VALUES (
            ${events[0].id}, ${representative.id}, 'asked',
            'pending'
          )
          ON CONFLICT (raw_event_id, representative_id) DO UPDATE SET
            participation = EXCLUDED.participation,
            status = CASE WHEN ${document.isCorrection} AND raw_event_targets.status = 'processed' THEN 'needs_review' ELSE raw_event_targets.status END
        `;
        await transaction`
          INSERT INTO td_facts (
            representative_id, fact_type, fact_payload, source_url, source_event_id, effective_at
          ) VALUES (
            ${representative.id}, 'question',
            ${transaction.json({
              questionNumber: question.questionNumber,
              questionType: question.questionType,
              title: question.sectionTitle,
              question: question.questionText,
              date: question.date,
            })},
            ${sourceUrl}, ${events[0].id}, ${`${question.date}T00:00:00Z`}
          )
          ON CONFLICT (representative_id, fact_type, source_event_id)
            WHERE source_event_id IS NOT NULL
          DO NOTHING
        `;
      }).then(() => { written += 1; });
      batch.push(task);
      if (batch.length >= 8) {
        await Promise.all(batch);
        batch = [];
      }
    }
    await Promise.all(batch);
    await finishRun(runId, "succeeded", seen, written, null, database);
    return { seen, written };
  } catch (error) {
    await finishRun(runId, "failed", seen, written, errorMessage(error), database);
    throw error;
  }
}

export async function syncDebates(
  dateStart: string,
  dateEnd: string,
  database: Database = getDatabase(),
  houses: HouseCode[] = ingestChambers(),
) {
  const runId = await startRun("oireachtas_debate", database);
  let seen = 0;
  let written = 0;
  try {
    const results: DebateResult[] = [];
    for (const house of houses) {
      results.push(...await fetchAll<DebateResult>("/debates", {
        chamber: house,
        chamber_type: "house",
        date_start: dateStart,
        date_end: dateEnd,
      }));
    }
    for (const result of results) {
      const record = result.debateRecord;
      if (!record?.uri || !record.date || !houses.includes(record.house?.houseCode as HouseCode) || record.house?.chamberType !== "house") continue;
      seen += 1;
      await database.begin(async (transaction) => {
        const document = await upsertOfficialDocument(transaction, {
          sourceType: "oireachtas_debate",
          sourceUri: record.uri!,
          date: record.date!,
          title: `${record.house?.showAs ?? HOUSES[record.house?.houseCode as HouseCode]?.label ?? "Dáil Éireann"} debate — ${record.date}`,
          canonicalUrl: record.uri!,
          xmlUrl: record.formats?.xml?.uri ?? null,
          lastUpdated: record.lastUpdated,
          rawPayload: result,
        });
        for (const sectionEntry of record.debateSections ?? []) {
          const section = sectionEntry.debateSection;
          if (!section?.uri || !section.containsDebate) continue;
          const groups = groupDebateContributions(section.text ?? []);
          for (const group of groups) {
            const representatives = await transaction<{ id: string }[]>`
              SELECT id FROM representatives
              WHERE (${group.memberCode} <> '' AND source_member_code = ${group.memberCode})
                 OR source_uri = ${group.memberUri}
              LIMIT 1
            `;
            const representative = representatives[0];
            const externalId = `${section.uri}::${group.memberCode || group.memberUri}`;
            const rawText = group.contributions.map((entry) => entry.text).join("\n\n").slice(0, 100_000);
            const rawPayload = {
              debateUri: record.uri,
              date: record.date,
              section: { uri: section.uri, id: section.debateSectionId, title: section.showAs },
              speaker: { memberCode: group.memberCode, uri: group.memberUri },
              contributions: group.contributions,
            };
            const events = await transaction<{ id: string }[]>`
              INSERT INTO raw_events (
                source_type, source_external_id, source_url, raw_payload, raw_text,
                dedupe_hash, status, official_document_id
              ) VALUES (
                'oireachtas_debate', ${externalId}, ${section.uri}, ${transaction.json(rawPayload)},
                ${rawText}, ${identityHash("oireachtas_debate", externalId)},
                ${representative ? "pending" : "needs_review"},
                ${document.documentId}
              )
              ON CONFLICT (source_type, source_external_id) DO UPDATE SET
                raw_payload = EXCLUDED.raw_payload, raw_text = EXCLUDED.raw_text,
                official_document_id = EXCLUDED.official_document_id,
                status = CASE WHEN ${document.isCorrection} AND raw_events.status = 'processed' THEN 'needs_review' ELSE raw_events.status END,
                fetched_at = now()
              RETURNING id
            `;
            if (!representative || !events[0]) continue;
            const contributions = group.contributions.map((contribution) => ({
              source_uri: `${section.uri}#text-${contribution.ordinal}`,
              ordinal: contribution.ordinal,
              contribution_text: contribution.text,
              content_hash: textHash(contribution.text),
              raw_payload: contribution.raw,
            }));
            await transaction`
              INSERT INTO official_contributions (
                official_document_version_id, representative_id, source_uri, section_id,
                ordinal, contribution_type, text, content_hash, raw_payload
              )
              SELECT ${document.versionId}, ${representative.id}, contribution.source_uri,
                ${section.debateSectionId ?? null}, contribution.ordinal, 'speech',
                contribution.contribution_text, contribution.content_hash, contribution.raw_payload
              FROM jsonb_to_recordset(${transaction.json(toJson(contributions))}) AS contribution(
                source_uri TEXT, ordinal INTEGER, contribution_text TEXT,
                content_hash TEXT, raw_payload JSONB
              )
              ON CONFLICT DO NOTHING
            `;
            await transaction`
              INSERT INTO raw_event_targets (raw_event_id, representative_id, participation, status)
              VALUES (
                ${events[0].id}, ${representative.id}, ${`spoke: ${section.showAs ?? "debate"}`},
                'pending'
              )
              ON CONFLICT (raw_event_id, representative_id) DO UPDATE SET
                participation = EXCLUDED.participation,
                status = CASE WHEN ${document.isCorrection} AND raw_event_targets.status = 'processed' THEN 'needs_review' ELSE raw_event_targets.status END
            `;
            await transaction`
              INSERT INTO td_facts (
                representative_id, fact_type, fact_payload, source_url, source_event_id, effective_at
              ) VALUES (
                ${representative.id}, 'debate_contribution',
                ${transaction.json({
                  sectionId: section.debateSectionId,
                  sectionTitle: section.showAs,
                  contributionCount: group.contributions.length,
                  date: record.date,
                })},
                ${section.uri}, ${events[0].id}, ${`${record.date}T00:00:00Z`}
              )
              ON CONFLICT (representative_id, fact_type, source_event_id)
                WHERE source_event_id IS NOT NULL
              DO NOTHING
            `;
          }
        }
      });
      written += 1;
    }
    await finishRun(runId, "succeeded", seen, written, null, database);
    return { seen, written };
  } catch (error) {
    await finishRun(runId, "failed", seen, written, errorMessage(error), database);
    throw error;
  }
}

export async function syncLegislation(
  dateStart: string,
  dateEnd: string,
  database: Database = getDatabase(),
) {
  const runId = await startRun("oireachtas_legislation", database);
  let seen = 0;
  let written = 0;
  try {
    const results = await fetchAll<LegislationResult>("/legislation", {
      date_start: dateStart,
      date_end: dateEnd,
      lang: "en",
    });
    for (const result of results) {
      const bill = result.bill;
      if (!bill?.uri || !bill.billNo || !bill.billYear || !bill.shortTitleEn) continue;
      const billUri = bill.uri;
      const billNumber = bill.billNo;
      const billYear = bill.billYear;
      const billTitle = bill.shortTitleEn;
      seen += 1;
      const contentHash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
      const stageDate = bill.mostRecentStage?.event?.dates
        ?.map((entry) => entry.date)
        .filter((value): value is string => Boolean(value))
        .at(-1) ?? null;
      await database.begin(async (transaction) => {
        const documents = await transaction<{ id: string }[]>`
          INSERT INTO legislation_documents (
            source_uri, bill_number, bill_year, title, long_title, status, source,
            current_stage, current_stage_date, current_content_hash, last_updated_at
          ) VALUES (
            ${billUri}, ${billNumber}, ${billYear}, ${billTitle},
            ${stripMarkup(bill.longTitleEn ?? "")}, ${bill.status ?? "Unknown"},
            ${bill.source ?? "Unknown"}, ${bill.mostRecentStage?.event?.showAs ?? null},
            ${stageDate}, ${contentHash}, ${bill.lastUpdated ?? null}
          )
          ON CONFLICT (source_uri) DO UPDATE SET
            bill_number = EXCLUDED.bill_number, bill_year = EXCLUDED.bill_year,
            title = EXCLUDED.title, long_title = EXCLUDED.long_title,
            status = EXCLUDED.status, source = EXCLUDED.source,
            current_stage = EXCLUDED.current_stage, current_stage_date = EXCLUDED.current_stage_date,
            current_content_hash = EXCLUDED.current_content_hash,
            last_updated_at = EXCLUDED.last_updated_at, updated_at = now()
          RETURNING id
        `;
        const document = documents[0];
        if (!document) throw new Error("Unable to persist legislation document");
        await transaction`
          INSERT INTO legislation_versions (legislation_document_id, content_hash, raw_payload)
          VALUES (${document.id}, ${contentHash}, ${transaction.json(result)})
          ON CONFLICT (legislation_document_id, content_hash) DO NOTHING
        `;
        await transaction`DELETE FROM legislation_debate_links WHERE legislation_document_id = ${document.id}`;
        for (const debate of bill.debates ?? []) {
          if (!debate.uri) continue;
          await transaction`
            INSERT INTO legislation_debate_links (
              legislation_document_id, debate_uri, debate_section_id, debate_date, label
            ) VALUES (
              ${document.id}, ${debate.uri}, ${debate.debateSectionId ?? ""},
              ${debate.date ?? null}, ${debate.showAs ?? billTitle}
            ) ON CONFLICT DO NOTHING
          `;
        }
        await transaction`DELETE FROM legislation_related_documents WHERE legislation_document_id = ${document.id}`;
        for (const entry of bill.relatedDocs ?? []) {
          const related = entry.relatedDoc;
          if (!related?.uri) continue;
          await transaction`
            INSERT INTO legislation_related_documents (
              legislation_document_id, source_uri, document_type, label, language, pdf_url, xml_url
            ) VALUES (
              ${document.id}, ${related.uri}, ${related.docType ?? "document"},
              ${related.showAs ?? "Related document"}, ${related.lang ?? null},
              ${related.formats?.pdf?.uri ?? null}, ${related.formats?.xml?.uri ?? null}
            ) ON CONFLICT (legislation_document_id, source_uri) DO UPDATE SET
              document_type = EXCLUDED.document_type, label = EXCLUDED.label,
              language = EXCLUDED.language, pdf_url = EXCLUDED.pdf_url, xml_url = EXCLUDED.xml_url
          `;
        }
      });
      written += 1;
    }
    await finishRun(runId, "succeeded", seen, written, null, database);
    return { seen, written };
  } catch (error) {
    await finishRun(runId, "failed", seen, written, errorMessage(error), database);
    throw error;
  }
}

export function normalizeQuestion(result: QuestionResult) {
  const question = result.question;
  if (!question?.uri || !question.date || !question.showAs || !question.by?.uri) return null;
  return {
    uri: question.uri,
    date: question.date,
    questionNumber: question.questionNumber,
    questionType: question.questionType ?? "unknown",
    questionText: question.showAs.trim(),
    answerText: question.answerText?.trim() ?? "",
    memberCode: question.by.memberCode ?? question.by.uri.split("/").at(-1) ?? "",
    memberUri: question.by.uri,
    sectionUri: question.debateSection?.uri ?? null,
    sectionId: question.debateSection?.debateSectionId ?? null,
    sectionTitle: question.debateSection?.showAs?.trim() ?? "",
    xmlUrl: question.debateSection?.formats?.xml?.uri ?? null,
  };
}

export function groupDebateContributions(textEntries: DebateText[]) {
  const groups = new Map<string, {
    memberCode: string;
    memberUri: string;
    contributions: Array<{ ordinal: number; text: string; raw: DebateText }>;
  }>();
  textEntries.forEach((entry, ordinal) => {
    const text = entry.text?.trim();
    const memberUri = entry.speaker?.uri?.trim() ?? "";
    const memberCode = entry.speaker?.memberCode?.trim() ?? memberUri.split("/").at(-1) ?? "";
    if (!text || !memberUri || entry.textType !== "speech") return;
    const key = memberCode || memberUri;
    const group = groups.get(key) ?? { memberCode, memberUri, contributions: [] };
    group.contributions.push({ ordinal, text, raw: entry });
    groups.set(key, group);
  });
  return [...groups.values()];
}

export function stripMarkup(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMember(result: MemberResult, house: HouseCode = "dail") {
  const member = result.member;
  if (!member?.showAs || !member.uri) return null;
  const memberships = member.memberships?.map((entry) => entry.membership).filter(Boolean) ?? [];
  const activeMembership = memberships
    .filter((membership) => membership?.house?.houseCode === house && !membership.dateRange?.end)
    .at(-1);
  if (!activeMembership) return null;
  const party = activeMembership.parties?.find((entry) => !entry.party?.dateRange?.end)?.party
    ?? activeMembership.parties?.at(-1)?.party;
  const represent = activeMembership.represents?.[0]?.represent;
  const memberCode = member.uri.split("/").at(-1) ?? member.pId ?? slugify(member.showAs);

  return {
    key: slugify(member.showAs),
    uri: member.uri,
    memberCode,
    name: member.showAs,
    area: represent?.showAs ?? (house === "seanad" ? "Unknown panel" : "Unknown constituency"),
    areaUri: represent?.uri ?? `urn:daildex:constituency:${slugify(represent?.showAs ?? "unknown")}`,
    party: party?.showAs ?? "Independent",
    partyUri: party?.uri ?? `urn:daildex:party:${slugify(party?.showAs ?? "independent")}`,
  };
}

export function flattenVotes(tallies: VoteTallies) {
  const groups: Array<[string, VoteMember[]]> = [
    ["Tá", tallies?.taVotes?.members ?? []],
    ["Níl", tallies?.nilVotes?.members ?? []],
    ["Staon", tallies?.staonVotes?.members ?? []],
  ];
  return groups.flatMap(([participation, members]) =>
    members.map((entry) => ({
      participation,
      memberCode: entry.member?.memberCode ?? entry.member?.uri?.split("/").at(-1),
    })),
  );
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-IE")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function upsertOfficialDocument(
  transaction: TransactionDatabase,
  input: {
    sourceType: "oireachtas_question" | "oireachtas_debate";
    sourceUri: string;
    date: string;
    title: string;
    canonicalUrl: string;
    xmlUrl: string | null;
    lastUpdated?: string;
    rawPayload: unknown;
  },
) {
  const contentHash = createHash("sha256").update(JSON.stringify(input.rawPayload)).digest("hex");
  const existing = await transaction<{ id: string; current_content_hash: string }[]>`
    SELECT id, current_content_hash FROM official_documents
    WHERE source_type = ${input.sourceType} AND source_uri = ${input.sourceUri}
    FOR UPDATE
  `;
  const documents = await transaction<{ id: string }[]>`
    INSERT INTO official_documents (
      source_type, source_uri, document_date, title, canonical_url, xml_url,
      current_content_hash, last_updated_at
    ) VALUES (
      ${input.sourceType}, ${input.sourceUri}, ${input.date}, ${input.title},
      ${input.canonicalUrl}, ${input.xmlUrl}, ${contentHash}, ${input.lastUpdated ?? null}
    )
    ON CONFLICT (source_type, source_uri) DO UPDATE SET
      document_date = EXCLUDED.document_date, title = EXCLUDED.title,
      canonical_url = EXCLUDED.canonical_url, xml_url = EXCLUDED.xml_url,
      current_content_hash = EXCLUDED.current_content_hash,
      last_updated_at = EXCLUDED.last_updated_at, updated_at = now()
    RETURNING id
  `;
  const documentId = documents[0]?.id;
  if (!documentId) throw new Error("Unable to persist official document");
  await transaction`
    INSERT INTO official_document_versions (official_document_id, content_hash, raw_payload)
    VALUES (${documentId}, ${contentHash}, ${transaction.json(toJson(input.rawPayload))})
    ON CONFLICT (official_document_id, content_hash) DO NOTHING
  `;
  const versions = await transaction<{ id: string }[]>`
    SELECT id FROM official_document_versions
    WHERE official_document_id = ${documentId} AND content_hash = ${contentHash}
  `;
  const versionId = versions[0]?.id;
  if (!versionId) throw new Error("Unable to persist official document version");
  return {
    documentId,
    versionId,
    isCorrection: Boolean(existing[0] && existing[0].current_content_hash !== contentHash),
  };
}

function identityHash(sourceType: string, externalId: string): string {
  return createHash("sha256").update(`${sourceType}:${externalId}`).digest("hex");
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function fetchAll<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const results: T[] = [];
  const limit = 1000;
  for (let skip = 0; ; skip += limit) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries({ ...params, limit: String(limit), skip: String(skip) })) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "DailDex/0.1 (contact: admin@daildex.ie)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Oireachtas ${path} returned HTTP ${response.status}`);
    const page = (await response.json()) as ApiPage<T>;
    const pageResults = page.results ?? [];
    results.push(...pageResults);
    if (pageResults.length < limit) break;
  }
  return results;
}

async function startRun(sourceType: string, database: Database): Promise<string> {
  return database.begin(async (transaction) => {
    await transaction`
      UPDATE ingest_runs
      SET status = 'failed', error = 'Superseded by a later ingestion run', finished_at = now()
      WHERE source_type = ${sourceType} AND status = 'running'
    `;
    const rows = await transaction<{ id: string }[]>`
      INSERT INTO ingest_runs (source_type, status) VALUES (${sourceType}, 'running') RETURNING id
    `;
    if (!rows[0]) throw new Error("Unable to create ingest run");
    return rows[0].id;
  });
}

async function finishRun(
  id: string,
  status: "succeeded" | "failed",
  seen: number,
  written: number,
  error: string | null,
  database: Database,
) {
  await database`
    UPDATE ingest_runs
    SET status = ${status}, records_seen = ${seen}, records_written = ${written},
        error = ${error}, finished_at = now()
    WHERE id = ${id}
  `;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown ingestion error").slice(0, 2000);
}
