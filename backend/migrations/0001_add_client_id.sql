-- Migration: add client_id to conversations table
-- Run once against the production D1 database:
--   npx wrangler d1 execute website-avatar-db --remote --file=migrations/0001_add_client_id.sql
--
-- client_id stores the data-account-id value from the script tag so every
-- conversation can be queried by the account (client) that owns it.
-- DEFAULT '' keeps all existing rows valid — no data is lost.

ALTER TABLE conversations ADD COLUMN client_id TEXT NOT NULL DEFAULT '';
