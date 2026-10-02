# ADR 0001 — One API, one database, tenant per facility

Date: 2026-10-01 · Status: accepted

## Decision
Setu runs as a single Fastify API service on one PostgreSQL database. Every row carries `tenant_id`; Postgres row-level security enforces isolation. Background work (SMS, payment webhooks, PDF rendering, nightly rollups) runs in the same codebase via BullMQ workers.

## Why
One developer with Claude Code. A few hundred facilities is still one database. Splitting services now would cost weeks and buy nothing until an actual scaling or isolation need appears.

## Consequences
- Tenant must be set on every request (plugin) and every job (explicit argument).
- Any hospital that demands in-country or on-premise hosting gets the same monolith deployed separately (phase 5).
- Revisit when: a single tenant needs its own database for legal reasons, or the DB exceeds what one managed instance handles.
