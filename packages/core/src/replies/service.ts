import { getDatabase, type Database } from "@daildex/db";
import { aiReplyDraftSchema, AppError, replyAnswerSchema, type AiReplyDraft } from "@daildex/shared";
import { getEmailReplyDomain, getTokenPepper } from "../config";
import { createThreadToken } from "../security/tokens";

export type ClaimedReply = {
  replyId: string;
  emailMessageId: string;
  question: string;
  questionType: "explain_event" | "ask_vote_breakdown" | "ask_source" | "ask_history" | "ask_bill_impact" | "ask_party_position" | "unknown";
  representativeName: string;
  headline: string;
  explanation: string;
  participation: string | null;
  officialEventText: string | null;
  sourceUrl: string;
  sourceLabel: string;
  factHistory: Array<{
    id: string;
    factType: string;
    payload: Record<string, unknown>;
    sourceUrl: string;
    effectiveAt: string | null;
  }>;
  legislationEvidence: Array<{
    id: string;
    title: string;
    longTitle: string;
    status: string;
    source: string;
    currentStage: string | null;
    currentStageDate: string | null;
    sourceUri: string;
    relatedDocuments: Array<{ label: string; sourceUri: string; pdfUrl: string | null; xmlUrl: string | null }>;
  }>;
  policyEvidence: Array<{
    id: string;
    title: string;
    heading: string | null;
    topicTag: string;
    text: string;
    pageRef: string | null;
    sourceUrl: string;
    reviewedAt: string | null;
  }>;
};

export async function claimReply(workerId: string, database: Database = getDatabase()): Promise<ClaimedReply | null> {
  const rows = await database<ClaimedReply[]>`
    WITH candidate AS (
      SELECT id FROM ai_replies
      WHERE (
          status = 'pending' OR
          (status = 'failed' AND attempt_count < 5) OR
          (status = 'processing' AND locked_at < now() - interval '15 minutes')
        )
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    ), claimed AS (
      UPDATE ai_replies AS reply
      SET status = 'processing', locked_by = ${workerId}, locked_at = now(),
          attempt_count = attempt_count + 1, last_error = NULL
      FROM candidate WHERE reply.id = candidate.id
      RETURNING reply.*
    )
    SELECT claimed.id AS "replyId", claimed.email_message_id AS "emailMessageId",
      claimed.question, claimed.question_type AS "questionType",
      representative.name AS "representativeName", alert.headline,
      alert.explanation, target.participation, event.raw_text AS "officialEventText",
      alert.source_url AS "sourceUrl", alert.source_label AS "sourceLabel",
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', fact.id, 'factType', fact.fact_type, 'payload', fact.fact_payload,
          'sourceUrl', fact.source_url, 'effectiveAt', fact.effective_at
        ) ORDER BY fact.effective_at DESC NULLS LAST)
        FROM (
          SELECT * FROM td_facts history
          WHERE history.representative_id = alert.representative_id
          ORDER BY history.effective_at DESC NULLS LAST LIMIT 20
        ) fact
      ), '[]'::JSON) AS "factHistory",
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', legislation.id, 'title', legislation.title, 'longTitle', legislation.long_title,
          'status', legislation.status, 'source', legislation.source,
          'currentStage', legislation.current_stage, 'currentStageDate', legislation.current_stage_date,
          'sourceUri', legislation.source_uri,
          'relatedDocuments', COALESCE((
            SELECT json_agg(json_build_object(
              'label', related.label, 'sourceUri', related.source_uri,
              'pdfUrl', related.pdf_url, 'xmlUrl', related.xml_url
            )) FROM legislation_related_documents related
            WHERE related.legislation_document_id = legislation.id
          ), '[]'::JSON)
        ))
        FROM (
          SELECT * FROM legislation_documents source_legislation
          WHERE source_legislation.id IN (
            SELECT link.legislation_document_id FROM legislation_debate_links link
            WHERE link.debate_uri = COALESCE(
              event.raw_payload#>>'{debateUri}',
              event.raw_payload#>>'{division,debate,uri}'
            )
            AND (
              link.debate_section_id = COALESCE(
                event.raw_payload#>>'{section,id}',
                event.raw_payload#>>'{division,debate,debateSection}',
                ''
              ) OR link.debate_section_id = ''
            )
          )
          LIMIT 5
        ) legislation
      ), '[]'::JSON) AS "legislationEvidence",
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', evidence.id, 'title', evidence.title, 'heading', evidence.heading,
          'topicTag', evidence.topic_tag, 'text', evidence.chunk_text,
          'pageRef', evidence.source_page_ref, 'sourceUrl', evidence.source_url,
          'reviewedAt', evidence.reviewed_at
        ) ORDER BY evidence.rank DESC)
        FROM (
          SELECT policy.*, document.title, document.source_url, document.reviewed_at,
            ts_rank(to_tsvector('english', policy.chunk_text), plainto_tsquery('english', claimed.question)) AS rank
          FROM policy_chunks policy
          JOIN policy_documents document ON document.id = policy.policy_document_id
          WHERE policy.party_id = representative.party_id
            AND document.reviewed_at IS NOT NULL
            AND to_tsvector('english', policy.chunk_text) @@ plainto_tsquery('english', claimed.question)
          ORDER BY rank DESC LIMIT 8
        ) evidence
      ), '[]'::JSON) AS "policyEvidence"
    FROM claimed
    JOIN email_messages message ON message.id = claimed.email_message_id
    JOIN email_threads thread ON thread.id = message.email_thread_id
    JOIN alert_items alert ON alert.id = thread.alert_item_id
    JOIN representatives representative ON representative.id = alert.representative_id
    JOIN raw_event_targets target ON target.id = alert.raw_event_target_id
    JOIN raw_events event ON event.id = target.raw_event_id
  `;
  return rows[0] ?? null;
}

export async function writeReplyDraft(
  workerId: string,
  claimed: ClaimedReply,
  input: AiReplyDraft,
  model: { provider: string; model: string; promptVersion: string },
  database: Database = getDatabase(),
) {
  const draft = aiReplyDraftSchema.parse(input);
  if (draft.questionType !== claimed.questionType) throw new AppError("INVALID_REQUEST", "Reply type changed during generation.", 400);
  const evidenceSources = new Map<string, { id: string; label: string; url: string }>([
    ["official_event", { id: "official_event", label: claimed.sourceLabel, url: claimed.sourceUrl }],
    ...claimed.factHistory.map((fact) => [
      `fact:${fact.id}`,
      { id: `fact:${fact.id}`, label: `${fact.factType.replaceAll("_", " ")} record`, url: fact.sourceUrl },
    ] as const),
    ...claimed.legislationEvidence.map((bill) => [
      `bill:${bill.id}`,
      { id: `bill:${bill.id}`, label: bill.title, url: bill.sourceUri },
    ] as const),
    ...claimed.policyEvidence.map((policy) => [
      `policy:${policy.id}`,
      { id: `policy:${policy.id}`, label: policy.heading || policy.title, url: policy.sourceUrl },
    ] as const),
  ]);
  const resolvedSources = draft.citations.map((citation) => evidenceSources.get(citation));
  if (resolvedSources.some((source) => !source)) {
    throw new AppError("INVALID_REQUEST", "Reply cited evidence that was not supplied.", 400);
  }
  const answer = draft.uncertainty ? `${draft.answer}\n\n${draft.uncertainty}` : draft.answer;
  await database.begin(async (transaction) => {
    const replies = await transaction<{ id: string }[]>`
      UPDATE ai_replies SET answer = ${answer},
        sources = ${transaction.json(resolvedSources as Array<{ id: string; label: string; url: string }>)},
        confidence = ${draft.confidence}, model_metadata = ${transaction.json(model)},
        status = 'needs_review', locked_by = NULL, locked_at = NULL, last_error = NULL
      WHERE id = ${claimed.replyId} AND status = 'processing' AND locked_by = ${workerId}
      RETURNING id
    `;
    if (!replies[0]) throw new AppError("CONFLICT", "Reply lease is no longer owned by this worker.", 409);
    await transaction`
      INSERT INTO agent_runs (
        email_message_id, job_type, status, provider, model, prompt_version,
        response_payload, finished_at
      ) VALUES (
        ${claimed.emailMessageId}, 'email_reply', 'succeeded', ${model.provider}, ${model.model},
        ${model.promptVersion}, ${transaction.json(draft)}, now()
      )
    `;
  });
}

export async function writeUnsupportedReply(workerId: string, claimed: ClaimedReply, database: Database = getDatabase()) {
  const answer = claimed.questionType === "ask_bill_impact"
    ? "I could not link this alert to a reviewed official bill record, so I will not infer the bill's impact."
    : claimed.questionType === "ask_party_position"
      ? "I do not have a reviewed party-policy source that answers this question yet."
      : claimed.questionType === "ask_history"
        ? "I do not have enough sourced historical records to answer this question yet."
        : "I can currently answer questions that explain this event, show the vote breakdown, point to the official source, or use reviewed history and policy evidence.";
  await database`
    UPDATE ai_replies SET
      answer = ${answer},
      sources = ${database.json([{ id: "official_event", label: claimed.sourceLabel, url: claimed.sourceUrl }])},
      confidence = 1, status = 'needs_review', locked_by = NULL, locked_at = NULL
    WHERE id = ${claimed.replyId} AND status = 'processing' AND locked_by = ${workerId}
  `;
}

export async function releaseReply(
  workerId: string,
  claimed: ClaimedReply,
  error: string,
  model: { provider: string; model: string; promptVersion: string },
  database: Database = getDatabase(),
) {
  await database.begin(async (transaction) => {
    await transaction`
      UPDATE ai_replies SET status = CASE WHEN attempt_count >= 5 THEN 'needs_review' ELSE 'failed' END,
        last_error = ${error.slice(0, 2000)}, locked_by = NULL, locked_at = NULL
      WHERE id = ${claimed.replyId} AND locked_by = ${workerId}
    `;
    await transaction`
      INSERT INTO agent_runs (
        email_message_id, job_type, status, provider, model, prompt_version, error, finished_at
      ) VALUES (
        ${claimed.emailMessageId}, 'email_reply', 'failed', ${model.provider}, ${model.model},
        ${model.promptVersion}, ${error.slice(0, 2000)}, now()
      )
    `;
  });
}

export async function listReviewReplies(database: Database = getDatabase()) {
  return database`
    SELECT reply.id, reply.question, reply.question_type, reply.answer, reply.sources,
      reply.confidence, reply.model_metadata, reply.created_at,
      representative.name AS representative_name, alert.headline
    FROM ai_replies reply
    JOIN email_messages message ON message.id = reply.email_message_id
    JOIN email_threads thread ON thread.id = message.email_thread_id
    JOIN alert_items alert ON alert.id = thread.alert_item_id
    JOIN representatives representative ON representative.id = alert.representative_id
    WHERE reply.status = 'needs_review'
    ORDER BY reply.created_at
    LIMIT 100
  `;
}

export async function editReply(
  replyId: string,
  answerInput: string,
  actor: string,
  database: Database = getDatabase(),
) {
  const answer = replyAnswerSchema.parse(answerInput);
  return database.begin(async (transaction) => {
    const replies = await transaction<{ id: string }[]>`
      UPDATE ai_replies SET answer = ${answer}
      WHERE id = ${replyId} AND status = 'needs_review'
      RETURNING id
    `;
    if (!replies[0]) throw new AppError("NOT_FOUND", "Reply is not awaiting review.", 404);
    await transaction`
      INSERT INTO reply_review_actions (ai_reply_id, action, actor, revision)
      VALUES (${replyId}, 'edited', ${actor.slice(0, 200)}, ${transaction.json({ answer })})
    `;
    return { edited: true };
  });
}

export async function reviewReply(
  replyId: string,
  action: "approved" | "rejected",
  actor: string,
  reason = "",
  database: Database = getDatabase(),
) {
  return database.begin(async (transaction) => {
    const replies = await transaction<{
      id: string;
      answer: string | null;
      sources: Array<{ label?: string; url?: string }>;
      subscriber_id: string;
      email: string;
      thread_id: string;
      thread_token_version: number;
      subject: string;
      inbound_rfc_message_id: string | null;
      references_header: string | null;
    }[]>`
      SELECT reply.id, reply.answer, reply.sources, reply.subscriber_id,
        subscriber.email::TEXT AS email, thread.id AS thread_id,
        thread.token_version AS thread_token_version, message.subject,
        message.rfc_message_id AS inbound_rfc_message_id, message.references_header
      FROM ai_replies reply
      JOIN subscribers subscriber ON subscriber.id = reply.subscriber_id
      JOIN email_messages message ON message.id = reply.email_message_id
      JOIN email_threads thread ON thread.id = message.email_thread_id
      WHERE reply.id = ${replyId} AND reply.status = 'needs_review'
      FOR UPDATE OF reply
    `;
    const reply = replies[0];
    if (!reply) throw new AppError("NOT_FOUND", "Reply is not awaiting review.", 404);
    await transaction`
      INSERT INTO reply_review_actions (ai_reply_id, action, actor, reason)
      VALUES (${reply.id}, ${action}, ${actor}, ${reason || null})
    `;
    if (action === "rejected") {
      await transaction`UPDATE ai_replies SET status = 'rejected' WHERE id = ${reply.id}`;
      return { action, queued: false };
    }
    if (!reply.answer) throw new AppError("CONFLICT", "Reply has no answer to approve.", 409);
    const sourceLines = reply.sources
      .filter((source) => source.url)
      .map((source) => `${source.label || "Official source"}: ${source.url}`)
      .join("\n");
    const text = `${reply.answer}\n\n${sourceLines}`.trim();
    const threadToken = createThreadToken(reply.thread_id, reply.thread_token_version, getTokenPepper());
    await transaction`
      INSERT INTO email_outbox (
        kind, recipient, payload, idempotency_key, subscriber_id, email_thread_id, ai_reply_id
      ) VALUES (
        'ai_reply', ${reply.email},
        ${transaction.json({
          subject: reply.subject.toLowerCase().startsWith("re:") ? reply.subject : `Re: ${reply.subject}`,
          text,
          html: `<p>${escapeHtml(reply.answer)}</p>${reply.sources.map((source) => source.url ? `<p><a href="${escapeHtml(source.url)}">${escapeHtml(source.label || "Official source")}</a></p>` : "").join("")}`,
          replyTo: `reply+${threadToken}@${getEmailReplyDomain()}`,
          inReplyTo: reply.inbound_rfc_message_id ?? undefined,
          references: [reply.references_header, reply.inbound_rfc_message_id].filter(Boolean).join(" ") || undefined,
        })},
        ${`ai-reply:${reply.id}`}, ${reply.subscriber_id}, ${reply.thread_id}, ${reply.id}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `;
    await transaction`UPDATE ai_replies SET status = 'draft' WHERE id = ${reply.id}`;
    return { action, queued: true };
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
