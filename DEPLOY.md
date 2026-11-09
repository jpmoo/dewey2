# Deploying Dewey 2.0

A full server setup for Ubuntu, served under a sub-path (`/dewey`) behind Caddy.
Adjust the path, port, and hostname to taste.

Target topology used throughout this doc:

```
Browser ──HTTPS──> Caddy (home-server.tailce6f0c.ts.net)
                     │  reverse_proxy /dewey*  (prefix kept, not stripped)
                     ▼
                Next.js app on 127.0.0.1:3032  (basePath /dewey)
                     │
                     ▼
                Postgres on 127.0.0.1:5432  (database "dewey2")
```

---

## 1. Prerequisites

Install Node.js 20 LTS, Postgres, and git.

```bash
# Node.js 20 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Postgres + git
sudo apt update
sudo apt install -y postgresql git

# Verify
node --version   # v20.x
psql --version
```

---

## 2. Database

Create the app role and a database it owns. Pick your own password; if it
contains URL-special characters (`@ : / # ? *` …) prefer percent-encoding it in
the connection string, or just choose an alphanumeric password.

```bash
sudo -u postgres psql -c "CREATE USER dewey2 WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "CREATE DATABASE dewey2 OWNER dewey2;"

# Postgres 15+: ensure the role can create tables in schema public.
# Harmless to re-run; required if the database already existed without OWNER.
sudo -u postgres psql -d dewey2 -c "ALTER DATABASE dewey2 OWNER TO dewey2;"
sudo -u postgres psql -d dewey2 -c "ALTER SCHEMA public OWNER TO dewey2;"
sudo -u postgres psql -d dewey2 -c "GRANT ALL ON SCHEMA public TO dewey2;"
```

Confirm the credentials work over TCP (this is how the app connects):

```bash
psql "postgres://dewey2:CHANGE_ME@localhost:5432/dewey2" -c "SELECT 1;"
```

The app creates its own tables on first launch — no migration step.

**pgvector** is required for the in-house RAG (document retrieval). Install the
extension and the app will `CREATE EXTENSION` on first launch (guarded — without
it, RAG features simply report "unavailable" and the rest of the app runs fine):

```bash
sudo apt install -y postgresql-16-pgvector   # match your Postgres major version
```

---

## 2b. RAG document ingestion (optional, for the Documents library)

Retrieval grounds the AI in uploaded documents. Embeddings run locally via Ollama;
the ingest pipeline is layered and best-effort — each tool below is optional, and
ingest degrades gracefully if it's missing.

```bash
# Text/PDF pipeline
sudo apt install -y poppler-utils tesseract-ocr libreoffice
# (poppler-utils = pdftoppm for page rasterization; tesseract = OCR of scanned
#  pages; libreoffice = convert Word/PPT/etc. → PDF. img2pdf/imagemagick optional
#  for image-only uploads.)

# Local models (Ollama)
ollama pull nomic-embed-text          # embeddings (default; selectable in System settings)
ollama pull llama3.2-vision           # reads charts/figures during ingest (optional)
```

Then, in the admin **System** settings, set the **Embedding model** (defaults to
`nomic-embed-text`) and, to index charts/figures, the **Vision model**. Documents
are managed in the admin **Documents** tab.

---

## 3. Clone and configure

```bash
cd ~
git clone https://github.com/jpmoo/dewey2.git
cd dewey2
cp .env.example .env
```

Edit `.env`:

```ini
PORT=3032

# Must match the Caddy prefix and the start of the NEXTAUTH_URL path. Leading slash, no trailing slash.
NEXT_PUBLIC_BASE_PATH=/dewey

DATABASE_URL=postgres://dewey2:CHANGE_ME@localhost:5432/dewey2

# Generate with: openssl rand -base64 32
NEXTAUTH_SECRET=your-generated-secret
# With a base path, include the full auth route, as NextAuth treats any path here as its auth route.
NEXTAUTH_URL=https://home-server.tailce6f0c.ts.net/dewey/api/auth
```

`NEXT_PUBLIC_BASE_PATH` is baked in at build time, so it must be set **before**
you build.

For "Sign in with Google", also set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`,
and add this authorized redirect URI to the OAuth client in Google Cloud:
`https://home-server.tailce6f0c.ts.net/dewey/api/auth/callback/google`

A Google account with no matching Dewey email is asked for a name, title, and
schools, then becomes a partner in the district. So anyone the OAuth client lets
through can sign up: set its user type to **Internal** in Google Cloud to keep it
to your Workspace domain.

---

## 4. Build

```bash
npm ci
npm run build
```

---

## 5. Run as a service (systemd --user)

A user service keeps the app running and restarts it on failure. `restart.sh`
detects and uses this service automatically.

Create `~/.config/systemd/user/dewey2.service`:

```ini
[Unit]
Description=Dewey 2.0
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/dewey2
ExecStart=/usr/bin/node %h/dewey2/node_modules/.bin/next start -p 3032
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

> If `which node` is not `/usr/bin/node`, update `ExecStart` accordingly.

Enable and start it, and allow it to run without an active login session:

```bash
systemctl --user daemon-reload
systemctl --user enable --now dewey2
sudo loginctl enable-linger "$USER"

# Status / logs
systemctl --user status dewey2
journalctl --user -u dewey2 -f
```

---

## 6. Caddy

Caddy must forward the `/dewey` prefix **unchanged** — the app expects to
receive it (that's what `basePath` means). Use `reverse_proxy` with a path
matcher, **not** `handle_path` (which strips the prefix and breaks assets/auth).

```caddy
home-server.tailce6f0c.ts.net {
    reverse_proxy /dewey* 127.0.0.1:3032
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy   # or: caddy reload --config /etc/caddy/Caddyfile
```

---

## 7. First run

Open `https://home-server.tailce6f0c.ts.net/dewey`.

Because no admin exists yet, you land on the **setup** screen. Create the
dedicated admin account. On submit the app also creates the `system_settings`
row and the demo accounts (`jcoach` / `jpartner`, passwords matching the
usernames — change or remove them in production). You're then signed in and
dropped at the admin console.

---

## 8. Updating

From the repo directory:

```bash
./restart.sh
```

It pulls, runs `npm ci` if `package-lock.json` changed, builds into `.next-build`,
and only then swaps that build in and restarts the `dewey2` service (falling back
to a backgrounded `next start` if the service isn't installed). If the build fails,
the running app and its current build are left alone. The build downloads fonts
from Google, so the server needs working DNS and outbound HTTPS.

Because `NEXT_PUBLIC_BASE_PATH` is build-time, always restart via this script (or
a manual rebuild) after changing it — restarting the process alone won't pick it
up. Other `.env` changes only need `systemctl --user restart dewey2`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Page loads but **no CSS/JS** (unstyled, console 404s on `/dewey/_next/...`) | Caddy is stripping the prefix. Use `reverse_proxy /dewey*`, not `handle_path`. |
| **Sign-in loops or 404s** on `/dewey/api/auth/...` | `NEXTAUTH_URL` isn't `https://<host>/dewey/api/auth`, or `NEXT_PUBLIC_BASE_PATH` and the Caddy prefix don't match `/dewey`. Rebuild after changing the base path; `NEXTAUTH_URL` only needs a service restart. |
| Google sign-in shows **`Error 400: redirect_uri_mismatch`** | Google's **error details** link shows the URI the app sent. If it's `/dewey/callback/google`, `NEXTAUTH_URL` is missing `/api/auth`. Otherwise, the OAuth client whose ID is in `GOOGLE_CLIENT_ID` doesn't list `https://<host>/dewey/api/auth/callback/google` exactly, including any `www`. |
| Build fails with **`Failed to fetch ... from Google Fonts`** (`EAI_AGAIN`) | The server can't resolve or reach `fonts.googleapis.com`. Fix DNS or outbound access, then re-run `./restart.sh`. |
| Setup screen shows **"Database unavailable"** (503) | `DATABASE_URL` wrong, Postgres not running, or role/password mismatch. Re-run the `psql "postgres://..."` test from §2. |
| `permission denied for schema public` on first launch (Postgres error `42501`) | Postgres 15+ restricts who can create objects in schema `public`. The role isn't the schema owner. Fix without recreating the DB: `sudo -u postgres psql -d dewey2 -c "ALTER SCHEMA public OWNER TO dewey2;" -c "GRANT ALL ON SCHEMA public TO dewey2;"` then re-hit `/api/setup-status` (the app retries the bootstrap automatically). |
| Port already in use on restart | `lsof -ti tcp:3032 \| xargs kill -9`, then re-run `./restart.sh`. |
| Service doesn't survive logout/reboot | `sudo loginctl enable-linger "$USER"`. |
