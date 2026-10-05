import { getDatabase, type Database } from "@daildex/db";
import { alertDraftSchema, AppError } from "@daildex/shared";
import { getAppBaseUrl, getEmailReplyDomain, getTokenPepper } from "../config";
import { renderAlertEmail } from "../email/alert-template";
import { publicAlertSourceUrl } from "../official-data/urls";
import { aiReviewEnabled, AI_REVIEW_MODEL, reviewAlertWithModel, type AiReviewInput, type AiReviewResult } from "./ai-review";
import { createSubscriberToken, createThreadToken } from "../security/tokens";

/** Minimum importance for followers on the default "important only" level. */
export function importantAlertThreshold(value = process.env.ALERT_IMPORTANT_THRESHOLD): number {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.3;
}

/** Most alert emails one subscriber receives in any 24 hours. */
export function alertDailyEmailCap(value = process.env.ALERT_DAILY_EMAIL_CAP): number {
  const parsed = Number(value);
  return value && Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : 5;
}

export async function reviewAlert(
  alertItemId: string,
  action: "approved" | "rejected",
  actor: string,
  reason = "",
  database: Database = getDatabase(),
) {
  return database.begin(async (transaction) => {
    const alerts = await transaction<{
      id: string;
      representative_id: string;
      event_type: string;
      headline: string;
      explanation: string;
      topic_tags: string[];
      source_url: string;
      source_label: string;
      importance_score: number;
      status: string;
      representative_name: string;
      question_uri: string | null;
    }[]>`
      SELECT alert.*, representative.name AS representative_name,
        event.raw_payload #>> '{question,uri}' AS question_uri
      FROM alert_items alert
      JOIN representatives representative ON representative.id = alert.representative_id
      JOIN raw_event_targets target ON target.id = alert.raw_event_target_id
      JOIN raw_events event ON event.id = target.raw_event_id
      WHERE alert.id = ${alertItemId}
      FOR UPDATE OF alert
    `;
    const alert = alerts[0];
    if (!alert) throw new AppError("NOT_FOUND", "Alert item not found.", 404);
    if (!["needs_review", "draft"].includes(alert.status)) {
      throw new AppError("CONFLICT", "Alert item is not awaiting review.", 409);
    }

    // data.oireachtas.ie record ids return 403 in a browser; readers get the public page.
    alert.source_url = publicAlertSourceUrl(alert.source_url, alert.question_uri);
    await transaction`
      UPDATE alert_items SET status = ${action}, source_url = ${alert.source_url}, updated_at = now()
      WHERE id = ${alertItemId}
    `;
    await transaction`
      INSERT INTO review_actions (alert_item_id, action, actor, reason)
      VALUES (${alertItemId}, ${action}, ${actor}, ${reason || null})
    `;
    if (action === "rejected") return { action, queued: 0 };

    const subscribers = await transaction<{
      id: string;
      email: string;
      token_version: number;
      locale: "en" | "ga";
    }[]>`
      SELECT DISTINCT subscriber.id, subscriber.email::TEXT AS email,
        subscriber.token_version, subscriber.locale
      FROM subscriber_follows follow
      JOIN subscribers subscriber ON subscriber.id = follow.subscriber_id
      WHERE follow.representative_id = ${alert.representative_id}
        AND subscriber.status = 'active'
        AND ${alert.event_type} = ANY(follow.event_types)
        AND (cardinality(follow.topic_tags) = 0 OR follow.topic_tags && ${alert.topic_tags}::TEXT[])
        AND (follow.alert_level = 'all' OR ${alert.importance_score} >= ${importantAlertThreshold()})
    `;

    const pepper = getTokenPepper();
    const appBaseUrl = getAppBaseUrl();
    const replyDomain = getEmailReplyDomain();
    const dailyCap = alertDailyEmailCap();
    let queued = 0;
    for (const subscriber of subscribers) {
      // A heavy sitting day can produce dozens of divisions. Past the cap the
      // alert stays on the TD's page but is not emailed.
      const sentToday = await transaction<{ count: number }[]>`
        SELECT count(*)::INT AS count FROM email_outbox
        WHERE subscriber_id = ${subscriber.id} AND kind = 'alert' AND created_at > now() - INTERVAL '24 hours'
      `;
      if ((sentToday[0]?.count ?? 0) >= dailyCap) continue;
      const threads = await transaction<{ id: string; token_version: number }[]>`
        INSERT INTO email_threads (subscriber_id, alert_item_id)
        VALUES (${subscriber.id}, ${alert.id})
        ON CONFLICT (subscriber_id, alert_item_id) DO UPDATE SET
          last_message_at = email_threads.last_message_at
        RETURNING id, token_version
      `;
      const thread = threads[0];
      if (!thread) continue;
      const manageToken = createSubscriberToken(subscriber.id, "manage", subscriber.token_version, pepper);
      const unsubscribeToken = createSubscriberToken(subscriber.id, "unsubscribe", subscriber.token_version, pepper);
      const threadToken = createThreadToken(thread.id, thread.token_version, pepper);
      const localePrefix = subscriber.locale === "ga" ? "/ga" : "";
      const payload = renderAlertEmail({
        representativeName: alert.representative_name,
        headline: alert.headline,
        explanation: alert.explanation,
        sourceUrl: alert.source_url,
        sourceLabel: alert.source_label,
        manageUrl: `${appBaseUrl}${localePrefix}/manage/${encodeURIComponent(manageToken)}`,
        unsubscribeUrl: `${appBaseUrl}${localePrefix}/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
        unsubscribeApiUrl: `${appBaseUrl}/api/unsubscribe/${encodeURIComponent(unsubscribeToken)}`,
        replyTo: `reply+${threadToken}@${replyDomain}`,
        locale: subscriber.locale,
      });
      await transaction`
        INSERT INTO email_outbox (
          kind, recipient, payload, idempotency_key, subscriber_id, alert_item_id, email_thread_id
        ) VALUES (
          'alert', ${subscriber.email}, ${transaction.json(payload)},
          ${`alert:${alert.id}:${subscriber.id}`}, ${subscriber.id}, ${alert.id}, ${thread.id}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
      queued += 1;
    }
    return { action, queued };
  });
}

export async function listReviewAlerts(database: Database = getDatabase()) {
  return database`
    SELECT alert.id, alert.raw_event_target_id, alert.headline, alert.summary, alert.explanation,
      alert.source_url, alert.source_label, alert.importance_score, alert.confidence,
      alert.model_metadata, left(event.raw_text, 16000) AS raw_text,
      representative.name AS representative_name, alert.created_at
    FROM alert_items alert
    JOIN representatives representative ON representative.id = alert.representative_id
    JOIN raw_event_targets target ON target.id = alert.raw_event_target_id
    JOIN raw_events event ON event.id = target.raw_event_id
    WHERE alert.status = 'needs_review'
    ORDER BY alert.created_at
    LIMIT 100
  `;
}

export async function editAlert(
  alertItemId: string,
  revision: { headline: string; summary: string; explanation: string },
  actor: string,
  database: Database = getDatabase(),
) {
  return database.begin(async (transaction) => {
    const alerts = await transaction<{
      event_type: "vote" | "debate" | "pq" | "news";
      topic_tags: Array<"housing" | "health" | "economy" | "justice" | "education" | "environment" | "agriculture" | "foreign_affairs" | "immigration" | "infrastructure" | "social_welfare" | "procedural">;
      source_label: string;
      importance_score: number;
      confidence: number;
      headline: string;
      summary: string;
      explanation: string;
    }[]>`
      SELECT event_type, topic_tags, source_label, importance_score, COALESCE(confidence, 0) AS confidence,
        headline, summary, explanation
      FROM alert_items WHERE id = ${alertItemId} AND status = 'needs_review' FOR UPDATE
    `;
    const current = alerts[0];
    if (!current) throw new AppError("NOT_FOUND", "Alert is not awaiting review.", 404);
    const validated = alertDraftSchema.parse({
      eventType: current.event_type,
      headline: revision.headline,
      summary: revision.summary,
      explanation: revision.explanation,
      topicTags: current.topic_tags,
      sourceLabel: current.source_label,
      importanceScore: current.importance_score,
      confidence: current.confidence,
    });
    await transaction`
      UPDATE alert_items SET headline = ${validated.headline}, summary = ${validated.summary},
        explanation = ${validated.explanation}, updated_at = now()
      WHERE id = ${alertItemId}
    `;
    await transaction`
      INSERT INTO review_actions (alert_item_id, action, actor, revision)
      VALUES (
        ${alertItemId}, 'edited', ${actor.slice(0, 200)},
        ${transaction.json({
          previous: { headline: current.headline, summary: current.summary, explanation: current.explanation },
          next: { headline: validated.headline, summary: validated.summary, explanation: validated.explanation },
        })}
      )
    `;
    return { edited: true };
  });
}

export type AutoPublishCandidate = {
  eventType: string;
  headline: string;
  summary: string;
  explanation: string;
  sourceUrl: string;
  confidence: number;
  representativeName: string;
  participation: string | null;
  /** Date of the underlying record, YYYY-MM-DD. */
  eventDate: string;
};

export type AutoPublishDecision =
  | { decision: "approve" }
  | { decision: "expire"; reasons: string[] }
  | { decision: "hold"; reasons: string[] };

const OFFICIAL_SOURCE_HOSTS = ["oireachtas.ie", "data.oireachtas.ie", "www.oireachtas.ie"];
const CLAIMS_VOTED_FOR = /\bvot(?:ed|es|ing) (?:for|in favour)\b|\brecords? (?:a )?Tá\b|\bTá vote\b/i;
const CLAIMS_VOTED_AGAINST = /\bvot(?:ed|es|ing) against\b|\brecords? (?:a )?Níl\b|\bNíl vote\b/i;

export function autoPublishMaxAgeDays(value = process.env.ALERT_AUTO_PUBLISH_MAX_AGE_DAYS): number {
  const parsed = Number(value);
  return value && Number.isInteger(parsed) && parsed >= 1 && parsed <= 60 ? parsed : 3;
}

export function autoPublishMinConfidence(value = process.env.ALERT_AUTO_PUBLISH_MIN_CONFIDENCE): number {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.75;
}

/**
 * Deterministic checks that let a model draft go out without a person reading
 * it. Anything doubtful is held for /admin; anything too old to be news expires.
 */
export function evaluateAutoPublish(
  candidate: AutoPublishCandidate,
  now = new Date(),
  maxAgeDays = autoPublishMaxAgeDays(),
  minConfidence = autoPublishMinConfidence(),
): AutoPublishDecision {
  const ageDays = (now.getTime() - Date.parse(`${candidate.eventDate}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > maxAgeDays) {
    return { decision: "expire", reasons: [`record is older than ${maxAgeDays} days`] };
  }

  const reasons: string[] = [];
  const text = `${candidate.headline}\n${candidate.summary}\n${candidate.explanation}`;

  if (candidate.confidence < minConfidence) reasons.push(`confidence ${candidate.confidence} is below ${minConfidence}`);

  let host = "";
  try {
    const url = new URL(candidate.sourceUrl);
    host = url.protocol === "https:" ? url.hostname : "";
  } catch {
    host = "";
  }
  if (!OFFICIAL_SOURCE_HOSTS.includes(host)) reasons.push("source is not an official Oireachtas https link");

  if (/https?:\/\/|www\./i.test(text)) reasons.push("text contains a link");

  const comparable = (value: string) => value.replace(/[’‘`]/g, "'").toLocaleLowerCase("en-IE");
  const surname = candidate.representativeName.trim().split(/\s+/).pop()?.replace(/[^\p{L}'’-]/gu, "") ?? "";
  if (!surname || !comparable(text).includes(comparable(surname))) {
    reasons.push("text does not name the representative");
  }

  if (candidate.eventType === "vote") {
    if (candidate.participation === "Tá" && CLAIMS_VOTED_AGAINST.test(text)) {
      reasons.push("record says Tá but the text describes a vote against");
    } else if (candidate.participation === "Níl" && CLAIMS_VOTED_FOR.test(text)) {
      reasons.push("record says Níl but the text describes a vote for");
    } else if (candidate.participation === "Staon" && (CLAIMS_VOTED_FOR.test(text) || CLAIMS_VOTED_AGAINST.test(text))) {
      reasons.push("record says Staon but the text describes a yes or no vote");
    } else if (!["Tá", "Níl", "Staon"].includes(candidate.participation ?? "")) {
      reasons.push("vote has no recorded participation");
    }
  }

  return reasons.length ? { decision: "hold", reasons } : { decision: "approve" };
}

/** Keeps one run inside the service timeout; the rest wait for the next five-minute run. */
const MAX_AI_REVIEWS_PER_RUN = 30;

export const AUTO_PUBLISH_ACTOR = "auto-publisher";

/**
 * Approves drafts that pass evaluateAutoPublish, expires stale ones, and leaves
 * the rest in the review queue. Safe to run repeatedly.
 */
export async function autoPublishAlerts(
  {
    limit = 200,
    now = new Date(),
    aiReview = aiReviewEnabled() ? reviewAlertWithModel : null,
  }: { limit?: number; now?: Date; aiReview?: ((input: AiReviewInput) => Promise<AiReviewResult>) | null } = {},
  database: Database = getDatabase(),
) {
  const candidates = await database<(AutoPublishCandidate & { id: string; recordText: string | null; memberDetails: string | null; aiVerdict: string | null })[]>`
    SELECT alert.id, alert.event_type AS "eventType", alert.headline, alert.summary, alert.explanation,
      alert.source_url AS "sourceUrl", COALESCE(alert.confidence, 0)::FLOAT AS confidence,
      representative.name AS "representativeName", target.participation,
      COALESCE(event.raw_payload #>> '{division,date}', event.fetched_at::DATE::TEXT) AS "eventDate",
      left(event.raw_text, 6000) AS "recordText",
      alert.model_metadata #>> '{aiReview,verdict}' AS "aiVerdict",
      concat_ws(', ', representative.party_name, representative.area) AS "memberDetails"
    FROM alert_items alert
    JOIN representatives representative ON representative.id = alert.representative_id
    JOIN raw_event_targets target ON target.id = alert.raw_event_target_id
    JOIN raw_events event ON event.id = target.raw_event_id
    WHERE alert.status = 'needs_review'
    ORDER BY alert.created_at
    LIMIT ${limit}
  `;

  const result = { approved: 0, expired: 0, held: 0, deferred: 0, emailsQueued: 0 };
  let aiReviewsLeft = MAX_AI_REVIEWS_PER_RUN;
  for (const candidate of candidates) {
    const outcome = evaluateAutoPublish(candidate, now);
    try {
      if (outcome.decision === "approve") {
        // A draft the reviewer already held stays in /admin (it can still expire) and costs nothing again.
        if (candidate.aiVerdict === "hold") {
          result.held += 1;
          continue;
        }
        // An earlier run may have recorded an approval and stopped before sending; do not pay to review it twice.
        if (aiReview && candidate.aiVerdict !== "approve") {
          if (aiReviewsLeft <= 0) {
            result.deferred += 1;
            continue;
          }
          // The alert worker and the publish timer both run this. Claim the draft so exactly one of them reviews it.
          const claimed = await database`
            UPDATE alert_items
            SET model_metadata = model_metadata || ${database.json({ aiReview: { verdict: "reviewing", at: now.toISOString() } })}::JSONB
            WHERE id = ${candidate.id} AND status = 'needs_review'
              AND (
                model_metadata #>> '{aiReview,verdict}' IS NULL
                OR (model_metadata #>> '{aiReview,verdict}' = 'reviewing'
                    AND (model_metadata #>> '{aiReview,at}')::TIMESTAMPTZ < now() - INTERVAL '5 minutes')
              )
            RETURNING id
          `;
          if (!claimed.length) continue;
          aiReviewsLeft -= 1;
          let opinion: AiReviewResult;
          try {
            opinion = await aiReview({
              eventType: candidate.eventType,
              representativeName: candidate.representativeName,
              participation: candidate.participation,
              memberDetails: candidate.memberDetails ?? undefined,
              headline: candidate.headline,
              summary: candidate.summary,
              explanation: candidate.explanation,
              recordText: candidate.recordText ?? "",
            });
          } catch (error) {
            // A reviewer outage never approves or rejects; release the claim so the next run tries again.
            await database`UPDATE alert_items SET model_metadata = model_metadata - 'aiReview' WHERE id = ${candidate.id}`;
            result.deferred += 1;
            console.error(JSON.stringify({
              event: "alert.ai_review.failed",
              alertItemId: candidate.id,
              error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
            }));
            continue;
          }
          await database`
            UPDATE alert_items
            SET model_metadata = model_metadata || ${database.json({
              aiReview: { verdict: opinion.verdict, reasons: opinion.reasons, model: AI_REVIEW_MODEL, at: now.toISOString() },
            })}::JSONB
            WHERE id = ${candidate.id}
          `;
          if (opinion.verdict === "hold") {
            result.held += 1;
            console.log(JSON.stringify({ event: "alert.ai_review.held", alertItemId: candidate.id, reasons: opinion.reasons }));
            continue;
          }
        }
        const reviewed = await reviewAlert(candidate.id, "approved", AUTO_PUBLISH_ACTOR, "", database);
        result.approved += 1;
        result.emailsQueued += reviewed.queued;
      } else if (outcome.decision === "expire") {
        await reviewAlert(candidate.id, "rejected", AUTO_PUBLISH_ACTOR, `expired: ${outcome.reasons.join("; ")}`, database);
        result.expired += 1;
      } else {
        result.held += 1;
        console.log(JSON.stringify({ event: "alert.auto_publish.held", alertItemId: candidate.id, reasons: outcome.reasons }));
      }
    } catch (error) {
      // Another reviewer may have acted on it first; leave it for the next run.
      if (!(error instanceof AppError && error.code === "CONFLICT")) throw error;
    }
  }
  return result;
}
