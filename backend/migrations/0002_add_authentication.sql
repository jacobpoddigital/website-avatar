-- Migration 0002: Add magic link authentication
--
-- Design: conversations.user_id is always non-null (NOT NULL constraint).
--   Anonymous:     user_id = wc_visitor value,      visitor_id = NULL
--   Authenticated: user_id = authenticated_users.id, visitor_id = original wc_visitor
--
-- On sign-in, the auth worker updates:
--   UPDATE conversations SET user_id = authId, visitor_id = user_id WHERE user_id = visitorId
--
-- authenticated_users.visitor_id bridges back to the consent table for the first sign-in.
--
-- Run via: wrangler d1 execute website-avatar-db --file=migrations/0002_add_authentication.sql --remote

-- Already run in a prior attempt — table exists. Re-documented for reference only.
-- CREATE TABLE authenticated_users (...)

-- Add visitor_id to authenticated_users (bridge to consent table)
ALTER TABLE authenticated_users ADD COLUMN visitor_id TEXT;

-- Copy current user_id into visitor_id for all existing rows (reference snapshot)
UPDATE conversations SET visitor_id = user_id;

-- Indexes
CREATE INDEX idx_conversations_auth_user ON conversations(user_id);
CREATE INDEX idx_conversations_visitor   ON conversations(visitor_id);
