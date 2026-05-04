# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0](https://github.com/HealthyApps/health-auto-export-mcp-server/compare/v0.0.1...v1.0.0) - 2026-05-04

### Changed

- **MCP tool interface (Claude Desktop and spec-friendly):** Tool names are now stable identifiers (`get_health_metrics`, `get_workouts`, `get_symptoms`, `get_state_of_mind`, `get_medications`, `get_cycle_tracking`, `get_ecg`, `get_heart_notifications`) instead of spaced display titles (for example, `Get Health Metrics`).
- **Tool inputs:** Each tool now accepts only the Health Auto Export arguments (date range and domain-specific options). Host, port, raw JSON-RPC `method`, nested `params`, and per-call `timeout` are no longer exposed on the wire; the server connects using `HAE_HOST` and `HAE_PORT` from the environment and sends `callTool` over JSON-RPC internally.
- **Responses:** Successful tool results return formatted JSON (or raw text when parsing fails) instead of a long echo of the request plus response.
- **Networking:** Use a static `net` import instead of a dynamic import inside the request path.
- **Startup:** If the TCP health check to the iOS app fails, the process logs a warning and still starts the MCP server on stdio (no exit on failed health check).

### Configuration

- **Environment:** `.env.example` documents `HAE_HOST` instead of `HAE_IP_ADDRESS`, and quotes `HAE_TIMEOUT` for consistency with other variables.

### Breaking

- Clients or configs that referenced old tool names or passed `host` / `port` / `method` / `params` into tools must be updated to the new names and argument shapes.
- Deployments using `HAE_IP_ADDRESS` must switch to `HAE_HOST`.