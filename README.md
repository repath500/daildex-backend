# DáilDex backend

The open source backend behind [DáilDex](https://www.daildex.com): official
Oireachtas data ingestion, parliamentary record APIs, civic email alerts and
background workers. Released under the [MIT licence](LICENSE).

DáilDex's core feature is simple: follow your local TDs and receive an email when
they vote, speak or ask a parliamentary question, with a link to the official
record. We are committed to keeping the core service and most hosted features
free. We are still self funding the project; optional Dex Pro subscriptions help
with hosting, email delivery, AI costs and continued development.

## What is included

| Directory | Purpose |
| --- | --- |
| `apps/api` | Hono REST API, public read-only MCP endpoint, provider webhooks and internal review endpoints. |
| `apps/ingest` | Fetch members, votes, debates, existing questions and legislation from the Oireachtas API. |
| `apps/worker` | Email delivery, alert drafting and publication, replies, retention, editorial and webhook jobs. |
| `apps/mcp` | Internal tools for the separately configured Hermes alert agent. |
| `packages/db` | PostgreSQL client and versioned migrations. |
| `packages/shared` | Schemas, public errors and record types. |
| `packages/core` | Subscriptions, security, public queries, alert queues and application services. |
| `agent/hermes` | Versioned profile and prompts for the optional alert agent. |

This release contains the backend, not the hosted Next.js website or Dex chat
interface. The subscription services and email pipeline are here; operators
connect their own frontend to those services. No subscriber data, private chats,
production database, credentials or paid model access are included. The software
does not offer parliamentary question drafting. Existing questions and answers
remain part of the record you can retrieve.

## Run locally

You can run the record API on your own computer without a DáilDex subscription,
email account or AI provider. Install **Node.js 22**, **npm**, **Git** and **Docker
with Docker Compose**, then:

```bash
git clone https://github.com/repath500/daildex-backend.git
cd daildex-backend
npm ci
npm run setup:local
docker compose up -d --wait
npm run db:migrate
npm run ingest:members
npm run dev
```

`setup:local` creates an ignored `.env.local` with fresh tokens. PostgreSQL listens
on local port **55432**, and the API on **8787**. If you already have PostgreSQL
16 or newer, skip Docker and change both database URLs in `.env.local` to your
own database. Migrations require permission to create `pgcrypto`, `citext` and
`pg_trgm` extensions.

In another terminal:

```bash
curl http://127.0.0.1:8787/health/ready
curl 'http://127.0.0.1:8787/v1/representatives?limit=5'
```

Open [the local API reference](http://127.0.0.1:8787/docs) or
[the OpenAPI schema](http://127.0.0.1:8787/openapi.json).
The public MCP endpoint is `http://127.0.0.1:8787/mcp`.

Import other records in separate, bounded jobs:

```bash
npm run ingest:votes
npm run ingest:questions
npm run ingest:debates
npm run ingest:legislation
```

A new database starts empty. These commands fetch public records from the
Oireachtas; they do not copy DáilDex's hosted database. There is no scheduler in
this quick start. Repeat jobs or schedule them yourself to keep records current.

## Email alerts and model workflows

The basic record API and ingestion do not require an AI model. Sending emails
requires your own verified Resend account and domain. Alert drafting requires
your own compatible Hermes server and model provider configuration. Those
services can carry costs even though the code is free.

Email sending and model generation start disabled in the sample configuration.
Both an environment switch and a database runtime control govern each workflow.
See [workers and configuration](docs/workers.md) before enabling them. You need
your own frontend for subscription confirmation and management links; set
`APP_BASE_URL` to that frontend. The backend API does not serve those web pages.

## Development checks

```bash
npm run verify
```

This runs the secret scanner, lint, types and unit tests. Database integration
tests use a **separate, disposable database**, never your live instance. Set
`DATABASE_URL`, `MIGRATION_DATABASE_URL`, `PUBLIC_API_TEST_DATABASE_URL`,
`EDITORIAL_TEST_DATABASE_URL` and `BUDGET_TEST_DATABASE_URL` to that test database,
run migrations, and then `npm run test:db`. The included GitHub workflow does this
and checks API startup against PostgreSQL 16.

## Contribute

Open an issue with a reproducible problem, or send a pull request. Fixes to data
attribution, source links, accessibility of the API and local setup documentation
are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md). Include a failing example when reporting an incorrect
record or summary, and link the official source.

## Licence and attribution

Our code uses the MIT licence. Dependencies keep their own licences. Oireachtas
records remain subject to the Oireachtas Open Data PSI Licence; our API includes
source links and attribution. The code licence does not relicense third-party
data or model outputs. See [DATA-LICENSE.md](DATA-LICENSE.md).
