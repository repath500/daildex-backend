import { closeDatabase, getDatabase } from "@daildex/db";

const database = getDatabase();
const unconfirmedDays = boundedDays("RETENTION_UNCONFIRMED_DAYS", 7);
const providerPayloadDays = boundedDays("RETENTION_PROVIDER_PAYLOAD_DAYS", 30);
const messageDays = boundedDays("RETENTION_MESSAGE_DAYS", 365);
const deliveryDays = boundedDays("RETENTION_DELIVERY_EVENT_DAYS", 365);
const agentRunDays = boundedDays("RETENTION_AGENT_RUN_DAYS", 180);

const result = await database.begin(async (transaction) => {
  const cancelled = await transaction`
    UPDATE email_outbox SET status = 'cancelled', last_error = 'Expired by retention policy'
    WHERE status IN ('queued', 'failed')
      AND kind = 'confirm_subscription'
      AND created_at < now() - (${unconfirmedDays} * interval '1 day')
  `;
  const expiredSubscribers = await transaction`
    DELETE FROM subscribers
    WHERE status = 'pending' AND created_at < now() - (${unconfirmedDays} * interval '1 day')
  `;
  const requests = await transaction`
    DELETE FROM subscription_requests
    WHERE expires_at < now() - interval '2 days'
  `;
  const rateLimits = await transaction`
    DELETE FROM request_rate_limits WHERE window_started_at < now() - interval '2 days'
  `;
  const webhookPayloads = await transaction`
    UPDATE provider_webhook_events SET payload = '{"redacted":true,"retentionExpired":true}'::JSONB
    WHERE received_at < now() - (${providerPayloadDays} * interval '1 day')
      AND payload <> '{"redacted":true,"retentionExpired":true}'::JSONB
  `;
  const messages = await transaction`
    UPDATE email_messages SET body_text = NULL, body_html = NULL
    WHERE created_at < now() - (${messageDays} * interval '1 day')
      AND (body_text IS NOT NULL OR body_html IS NOT NULL)
  `;
  const deliveryEvents = await transaction`
    DELETE FROM email_delivery_events
    WHERE received_at < now() - (${deliveryDays} * interval '1 day')
  `;
  const agentRuns = await transaction`
    DELETE FROM agent_runs
    WHERE started_at < now() - (${agentRunDays} * interval '1 day')
  `;
  const privacyRequests = await transaction`
    DELETE FROM privacy_requests WHERE created_at < now() - interval '2 years'
  `;
  return {
    cancelled: cancelled.count,
    expiredSubscribers: expiredSubscribers.count,
    requests: requests.count,
    rateLimits: rateLimits.count,
    webhookPayloads: webhookPayloads.count,
    messages: messages.count,
    deliveryEvents: deliveryEvents.count,
    agentRuns: agentRuns.count,
    privacyRequests: privacyRequests.count,
  };
});

console.log(JSON.stringify({ event: "retention.completed", ...result }));
await closeDatabase();

function boundedDays(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 3650) throw new Error(`${name} must be an integer from 1 to 3650`);
  return value;
}
