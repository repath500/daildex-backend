# Optional email and model workers

The local quick start runs the record API and ingestion. These use public
Oireachtas records and PostgreSQL; no AI subscription is required.

## Email and subscriptions

Subscription lifecycle functions are exported from `@daildex/core/subscriptions`:
request a subscription, confirm the opaque token, manage follows and unsubscribe.
They validate requests and persist the email outbox. They are library functions,
not public signup routes in this standalone API. Connect your own frontend or
server integration. Set `APP_BASE_URL` to the frontend that implements `/confirm`
and the management and unsubscribe pages.

Email uses Resend. Set `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (a verified sender),
`RESEND_WEBHOOK_SECRET` and your own `EMAIL_REPLY_DOMAIN`. Configure the provider's
event endpoint to reach `/webhooks/email/events` on your deployment.

To enable outbound delivery, set `EMAIL_SENDING_ENABLED=true` and enable the
`email_sending` row in `runtime_controls` in your own database. Run
`npm run worker:email` to process one bounded batch. It is a one-shot job;
schedule it yourself for ongoing operation. The sample environment keeps it off.

## Alert drafting

The alert worker expects a separately installed Hermes server exposing the API
used by `apps/worker/src/hermes-client.ts`. The server must support the capability
probe as well as the configured drafting mode. The `agent/hermes` folder contains
the versioned profile, system instructions and alert-writing skills, not the
Hermes application itself or any model weights.

Configure `HERMES_API_BASE_URL`, `HERMES_API_KEY`, `HERMES_MODEL_PROVIDER`,
`HERMES_MODEL`, `HERMES_ALLOWED_PROVIDERS` and `HERMES_ALLOWED_MODELS` for your own
provider account and server. The current worker pins its model via `ALERT_MODEL`
in `apps/worker/src/alert-worker.ts`; selecting another model requires updating
that constant and the matching allowlist and Hermes configuration. The default
profile disables extra tools and provider fallbacks.

`HERMES_DRAFT_MODE=prompt_json` expects a structured JSON answer. The alternative
`mcp_tool` mode uses `apps/mcp`, requires `DAILDEX_AGENT_TOKEN`, and must match the
server's expected tools. Keep `apps/mcp` and `/internal/*` private.

After configuring and checking your server, set `HERMES_ALERTS_ENABLED=true` and
enable `alert_generation` in your own `runtime_controls` table. Run
`npm run worker:alert`. The sample also sets `ALERT_AUTO_PUBLISH=false`: review
drafts through the authenticated internal review endpoints before publishing.
Review endpoints require your `INTERNAL_API_TOKEN`. See `apps/api/src/app.ts`
for their request schemas. Publishing uses `npm run worker:publish`, and
sending still needs its own email gate.

## Other jobs

| Command | Purpose |
| --- | --- |
| `worker:webhook` | Process persisted email provider events. |
| `worker:reply` | Draft grounded replies; requires its own Hermes setup and `HERMES_REPLIES_ENABLED` plus `reply_generation`. |
| `worker:api-webhooks` | Queue and deliver public record webhook notifications. |
| `worker:retention` | Apply privacy retention rules. |
| `worker:reconcile-email` | Reconcile sending and provider delivery state. |
| `worker:editorial` | Optional news workflow; requires provider configuration and both editorial gates. |
| `worker:budget-live` | Optional budget workflow; requires provider configuration and both budget gates. |

Workers run bounded jobs and exit. For a continuing service, configure your own
scheduler. Check the entrypoint and environment controls before enabling a job;
provider calls and email delivery can cost money. Use independent credentials and
a test recipient when developing your integration.
