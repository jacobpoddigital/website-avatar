-- Migration 0004: Add usage_events table for analytics dashboard
--
-- Stores a lightweight event log for per-client activity metrics.
-- event_type values: session_started, webhook_call_complete,
--                    openai_greeting, openai_classify, openai_persona
--
-- Session/visitor counts are NOT tracked here — they come from the existing
-- conversations table which is already accurate and avoids double-counting.
--
-- Run via:
--   wrangler d1 execute website-avatar-db --file=migrations/0004_add_usage_events.sql --remote

CREATE TABLE IF NOT EXISTS usage_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  TEXT    NOT NULL,
  event_type TEXT    NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_usage_events_client_date
  ON usage_events (client_id, created_at);
