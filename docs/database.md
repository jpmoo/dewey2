# Dewey 2.0 — Database & Setup Specification

## Schema Overview

Four tables cover the full data model for users and system configuration.

### `districts`
Represents a school district. Created by an admin after first login.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| name | TEXT | e.g. "Erewhon School District" |
| created_at | TIMESTAMPTZ | |

### `schools`
A school within a district.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| district_id | FK → districts | Cascade delete |
| name | TEXT | e.g. "Atlantis Elementary School" |
| created_at | TIMESTAMPTZ | |

### `users`
All user accounts in one table. Role is stored as `system_role`.

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | |
| username | TEXT UNIQUE | Case-insensitive unique index |
| password_hash | TEXT | bcrypt, cost 12 |
| full_name | TEXT | Display name |
| nickname | TEXT | Preferred first name, used in coaching UI |
| email | TEXT | Optional |
| system_role | TEXT | `admin`, `coach`, or `partner` |
| district_id | FK → districts | Nullable |
| school_id | FK → schools | Nullable |
| role | TEXT | Job title / role in school (e.g. "3rd Grade Teacher") |
| about | TEXT | User-written self-description, used as coaching context |
| settings | JSONB | Per-user preferences (theme, UI state, etc.) Expandable. |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**system_role values:**
- `admin` — full system access; manages users, settings, org structure
- `coach` — builds coaching plans, monitors partners, approves phase advancement
- `partner` — receives coaching, completes activities

### `system_settings`
Single-row table. Enforced by a CHECK constraint (`id = 1`). Updated in place; never inserted twice.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Always 1 |
| ollama_url | TEXT | Base URL for local Ollama instance |
| ollama_classification_model | TEXT | Selected from live model list |
| ollama_coaching_model | TEXT | Selected from live model list |
| anthropic_api_key | TEXT | Stored here or via env var |
| rag_url | TEXT | RAGDoll API base URL |
| rag_default_threshold | FLOAT | Default similarity threshold |
| default_theme | TEXT | `light` or `dark` |
| settings | JSONB | Expandable bucket for future global settings |
| updated_at | TIMESTAMPTZ | |

---

## First-Run Setup Flow

### Step 1 — Empty database detection
On startup, the app checks for any `admin` user in the `users` table. If none exists, the app redirects every route to `/setup` before rendering anything else.

### Step 2 — Admin creation screen
The `/setup` page collects:
- Username
- Password (minimum 8 characters, confirmed)
- Full name
- Nickname (optional)
- Email (optional)

On submit, the API:
1. Verifies no admin exists (guard against race conditions)
2. Hashes the password with bcrypt (cost 12)
3. Inserts the user with `system_role = 'admin'`
4. Inserts the `system_settings` row with defaults
5. Runs `createDemoUsers()` to create `jcoach` and `jpartner`
6. Redirects to the admin dashboard

### Step 3 — Demo user creation (`createDemoUsers`)
Called automatically after admin setup. Creates two accounts if they don't already exist:

**jcoach**
- username: `jcoach`
- password: `jcoach` (hashed at runtime)
- full_name: `John Coach`
- nickname: `John`
- system_role: `coach`
- district: Erewhon School District
- school: Atlantis Elementary School
- role: `Instructional Literacy Coach`
- about: (empty)

**jpartner**
- username: `jpartner`
- password: `jpartner` (hashed at runtime)
- full_name: `Jane Partner`
- nickname: `Jane`
- system_role: `partner`
- district: Erewhon School District
- school: Atlantis Elementary School
- role: `3rd Grade Teacher`
- about: (empty)

The district and school are also created at this point if they don't exist (using the seed data from `docs/db/seed.sql` as reference).

---

## System Settings: Ollama Configuration

The admin settings UI includes an Ollama section:

1. **Ollama URL** — text field, e.g. `http://localhost:11434`
2. **Test / Refresh** button — hits `GET {ollama_url}/api/tags` to fetch the installed model list
3. On success, populates two independent dropdowns:
   - **Classification / Summarization model** — used for arc classification, compliance screening, summarization
   - **Coaching model** (Ollama option) — used for the coaching engine if not using Claude API
4. Both dropdowns are independently refreshable without changing the URL

The Anthropic API key field is separate from the Ollama section. When a Claude model is selected as the coaching model, the Ollama coaching model setting is ignored.

---

## `settings` JSONB Fields

The `users.settings` JSONB column is the expandable bucket for per-user preferences. Initial keys:

```json
{
  "theme": "light",
  "panel_state": "open",
  "chat_font_size": 16
}
```

The `system_settings.settings` JSONB column holds global preferences that don't warrant their own column yet. Initially empty (`{}`).

---

## Notes for Implementation

- **Never store plain-text passwords.** Always bcrypt before insert.
- **The `seed.sql` file documents intent only.** The actual demo user insertion must go through `createDemoUsers()` in `lib/db.ts` so passwords are hashed at runtime.
- **The setup route must be idempotent.** If called twice (e.g. browser back button), the second call should detect the existing admin and return a clean error, not crash.
- **District/school assignment is optional at user creation time.** Admins can assign later.
- **`system_role` is not the same as `role`.** `system_role` is access control. `role` is the person's job title and is used as coaching context.
