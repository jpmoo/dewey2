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
```

Confirm the credentials work over TCP (this is how the app connects):

```bash
psql "postgres://dewey2:CHANGE_ME@localhost:5432/dewey2" -c "SELECT 1;"
```

The app creates its own tables on first launch — no migration step.

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

# Must match the Caddy prefix and the NEXTAUTH_URL path. Leading slash, no trailing slash.
NEXT_PUBLIC_BASE_PATH=/dewey

DATABASE_URL=postgres://dewey2:CHANGE_ME@localhost:5432/dewey2

# Generate with: openssl rand -base64 32
NEXTAUTH_SECRET=your-generated-secret
NEXTAUTH_URL=https://home-server.tailce6f0c.ts.net/dewey
```

`NEXT_PUBLIC_BASE_PATH` is baked in at build time, so it must be set **before**
you build.

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

It pulls, frees the port, runs a clean `npm ci && npm run build`, and restarts
the `dewey2` service (falling back to a backgrounded `next start` if the service
isn't installed). Because `NEXT_PUBLIC_BASE_PATH` is build-time, always restart
via this script (or a manual rebuild) after changing it — restarting the process
alone won't pick it up.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Page loads but **no CSS/JS** (unstyled, console 404s on `/dewey/_next/...`) | Caddy is stripping the prefix. Use `reverse_proxy /dewey*`, not `handle_path`. |
| **Sign-in loops or 404s** on `/dewey/api/auth/...` | `NEXTAUTH_URL` path, `NEXT_PUBLIC_BASE_PATH`, and the Caddy prefix don't all match `/dewey`. Rebuild after fixing. |
| Setup screen shows **"Database unavailable"** (503) | `DATABASE_URL` wrong, Postgres not running, or role/password mismatch. Re-run the `psql "postgres://..."` test from §2. |
| `permission denied for schema public` on first launch | The role doesn't own the database. Recreate it with `CREATE DATABASE dewey2 OWNER dewey2;`. |
| Port already in use on restart | `lsof -ti tcp:3032 \| xargs kill -9`, then re-run `./restart.sh`. |
| Service doesn't survive logout/reboot | `sudo loginctl enable-linger "$USER"`. |
