# Reporting a security issue

Email support@daildex.com with the affected component, steps to reproduce and
expected impact. Please report exploitable issues privately rather than placing
credentials or personal data in a public issue.

Local examples are for development. Before exposing an instance, configure TLS,
rate limiting, backups, retention, independent credentials and a private boundary
for `/internal/*`. Never expose `apps/mcp` to the public internet; it is the
internal agent toolset. The public read-only MCP endpoint is `/mcp` in `apps/api`.
