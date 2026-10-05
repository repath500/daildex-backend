# DáilDex Hermes profile

Create an isolated profile with the current Hermes CLI, then copy the versioned
identity, skill and `profiles/dail-watcher/config.yaml` into that profile. Keep
provider/API credentials only in the profile's private `.env` or the systemd
environment file.

```bash
hermes profile create dail-watcher
dail-watcher setup
dail-watcher gateway install --system
```

The checked-in systemd unit runs `hermes --profile dail-watcher gateway run` in
the foreground. It binds the API server to loopback and is ordered after the
DáilDex API. The worker probes `/v1/capabilities` and `/v1/toolsets` before it
claims work; a mismatch is a startup failure, not a best-effort warning.

Production requirements:

- Run as a dedicated non-root user.
- Bind the API server to loopback/private networking.
- Set a strong `API_SERVER_KEY`; map the same secret to the worker's
  `HERMES_API_KEY`.
- Enable no terminal, filesystem, browser, general web, messaging, or database
  tools for the alert worker.
- Pin the production provider and model. Do not silently fall back to a free model.
- When `HERMES_MODEL_PROVIDER=openrouter`, provide `OPENROUTER_API_KEY` only in
  the profile's private `.env` or `/etc/daildex/hermes.env`. The deployment may
  reuse the project's root OpenRouter credential, but it must never be committed.
- Keep `fallback_providers` empty for public alert generation. Hermes configures
  primary fallback in `config.yaml`, so an operator must treat any non-empty
  fallback list as a reviewed deployment change.
- The worker passes one already-claimed official event and validates all output in
  application code. PostgreSQL leases, not Hermes sessions, provide durability.

The safe profile starts with no API-server tools. After the tool-less prompt JSON
path passes its eval and production checks, change `platform_toolsets.api_server`
to `[mcp-daildex]`, set `HERMES_DRAFT_MODE=mcp_tool`, and set the expected
`mcp_daildex_*` names in `HERMES_EXPECTED_TOOL_NAMES` (the six names are
`mcp_daildex_get_claimed_event`, `mcp_daildex_get_td_history`,
`mcp_daildex_find_similar_previous_alerts`, `mcp_daildex_search_official_records`,
`mcp_daildex_submit_alert_draft`, and `mcp_daildex_record_alert_outcome`). The DáilDex MCP server
exposes only leased-event retrieval, bounded history/context lookup, official
record search, strict draft submission, and bounded skip/merge/more-context
outcomes. It never exposes arbitrary SQL, terminal, filesystem, browser,
messaging, or unbounded source fetching.

## Skills

- `skills/daildex-alert-writing` — used by `apps/worker/src/alert-worker.ts`.
- `skills/daildex-reply-writing` — used by `apps/worker/src/reply-worker.ts`.

The alert worker sends a compact inline job prompt and hashes the versioned
`SOUL.md` plus alert skill into `prompt_version`; `SOUL.md` is also applied
server-side by the profile. Treat the files in `skills/` as the versioned source
of truth for the worker's editorial contract — when you change one, change the
inline prompt contract in the same change, and re-run `npm run eval:alerts`
(and its reply equivalent, once it exists) before enabling the runtime control.
