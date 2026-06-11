-- Dewey 2.0: Seed data
-- Run after schema.sql and after the admin setup flow creates the admin user.
-- This seed is applied automatically by the app on first launch once an admin
-- exists and the database has no district data yet.
--
-- Creates:
--   - Erewhon School District
--   - Atlantis Elementary School (within that district)
--   - Two demo users: jcoach and jpartner
--
-- Demo user passwords are intentionally weak (matching the username) and
-- are clearly labeled as demo accounts. Admins should replace or remove
-- them in production.

BEGIN;

-- Organizations
INSERT INTO districts (id, name)
VALUES (1, 'Erewhon School District')
ON CONFLICT DO NOTHING;

INSERT INTO schools (id, district_id, name)
VALUES (1, 1, 'Atlantis Elementary School')
ON CONFLICT DO NOTHING;

-- Reset sequences to avoid collision after explicit IDs above
SELECT setval('districts_id_seq', (SELECT MAX(id) FROM districts));
SELECT setval('schools_id_seq',   (SELECT MAX(id) FROM schools));

-- Demo users
-- Passwords below are bcrypt hashes of the username string (cost 12).
-- jcoach   → hash of 'jcoach'
-- jpartner → hash of 'jpartner'
-- These are replaced at runtime by the app's setup routine using the actual
-- bcrypt library. The placeholder text below is a reminder to the setup
-- code that it must hash before inserting.

-- NOTE TO SETUP CODE: do not insert these rows directly from this file.
-- Instead, call the createDemoUsers() function in lib/db.ts, which hashes
-- the passwords at runtime before inserting. This file documents intent;
-- the function does the actual work.

-- jcoach
INSERT INTO users (username, password_hash, full_name, nickname, system_role, district_id, school_id, role, about, settings)
VALUES (
  'jcoach',
  '__HASH_OF_jcoach__',          -- replaced by createDemoUsers() at runtime
  'John Coach',
  'John',
  'coach',
  1,
  1,
  'Instructional Literacy Coach',
  '',
  '{}'
)
ON CONFLICT DO NOTHING;

-- jpartner
INSERT INTO users (username, password_hash, full_name, nickname, system_role, district_id, school_id, role, about, settings)
VALUES (
  'jpartner',
  '__HASH_OF_jpartner__',        -- replaced by createDemoUsers() at runtime
  'Jane Partner',
  'Jane',
  'partner',
  1,
  1,
  '3rd Grade Teacher',
  '',
  '{}'
)
ON CONFLICT DO NOTHING;

COMMIT;
