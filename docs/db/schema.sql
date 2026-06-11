-- Dewey 2.0: PostgreSQL schema
-- Run once: psql $DATABASE_URL -f docs/db/schema.sql
-- On first app launch with an empty database, the app detects no admin user
-- and presents the admin setup screen before anything else.

BEGIN;

-- ============================================================
-- ORGANIZATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS districts (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS schools (
  id          SERIAL PRIMARY KEY,
  district_id INTEGER NOT NULL REFERENCES districts (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USERS
-- ============================================================

-- system_role controls access level within the app:
--   admin   — full system access, manages users/settings/orgs
--   coach   — builds coaching plans, works with partners
--   partner — receives coaching, completes activities

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  nickname       TEXT,
  email          TEXT,
  system_role    TEXT NOT NULL DEFAULT 'partner'
                   CHECK (system_role IN ('admin', 'coach', 'partner')),
  district_id    INTEGER REFERENCES districts (id) ON DELETE SET NULL,
  school_id      INTEGER REFERENCES schools (id) ON DELETE SET NULL,
  role           TEXT,        -- job title / role in school (e.g. "3rd Grade Teacher")
  about          TEXT,        -- user-written self-description
  settings       JSONB NOT NULL DEFAULT '{}',  -- theme, preferences, etc.
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username));

-- ============================================================
-- SYSTEM SETTINGS
-- ============================================================

-- Single-row table for global system configuration.
-- One row is inserted at setup time and updated in place.
-- ollama_classification_model and ollama_coaching_model are
-- chosen from the live model list fetched from the Ollama URL.

CREATE TABLE IF NOT EXISTS system_settings (
  id                           INTEGER PRIMARY KEY DEFAULT 1
                                 CHECK (id = 1),   -- enforce single row
  ollama_url                   TEXT,
  ollama_classification_model  TEXT,
  ollama_coaching_model        TEXT,
  anthropic_api_key            TEXT,               -- stored encrypted or via env
  rag_url                      TEXT,
  rag_default_threshold        DOUBLE PRECISION DEFAULT 0.5,
  default_theme                TEXT DEFAULT 'light',
  settings                     JSONB NOT NULL DEFAULT '{}',  -- expandable bucket
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
