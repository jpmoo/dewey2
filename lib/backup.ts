import { spawn } from "child_process";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { createGzip } from "zlib";
import { getSystemSettings } from "@/lib/settings";

/**
 * Daily on-server backup: a gzipped pg_dump of the whole database (which includes
 * uploaded attachments/avatars, stored as BYTEA) into backups/<YYYY-MM-DD>/ in
 * the project root. Triggered lazily (on login) — it checks whether today's
 * folder exists and only runs if not — and prunes folders older than the
 * admin-configured retention window (default 30 days).
 */

const BACKUPS_DIR = path.join(process.cwd(), "backups");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Module-level guard so concurrent logins don't kick off duplicate runs.
let running: Promise<void> | null = null;

export interface BackupInfo {
  date: string;
  sizeBytes: number;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else {
      const st = await fs.stat(full).catch(() => null);
      if (st) total += st.size;
    }
  }
  return total;
}

export async function listBackups(): Promise<BackupInfo[]> {
  const entries = await fs.readdir(BACKUPS_DIR, { withFileTypes: true }).catch(() => []);
  const dates = entries.filter((e) => e.isDirectory() && DATE_RE.test(e.name)).map((e) => e.name);
  dates.sort().reverse();
  const out: BackupInfo[] = [];
  for (const date of dates) {
    out.push({ date, sizeBytes: await dirSize(path.join(BACKUPS_DIR, date)) });
  }
  return out;
}

/** pg_dump the database (gzipped) to dest, using DATABASE_URL. */
function dumpDatabase(destFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = process.env.DATABASE_URL;
    if (!url) return reject(new Error("DATABASE_URL is not set"));
    const child = spawn("pg_dump", ["--no-owner", "--no-privileges", url], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject); // e.g. pg_dump not installed
    const gz = createGzip();
    const out = createWriteStream(destFile);
    child.stdout.pipe(gz).pipe(out);
    out.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

async function pruneOldBackups(keepDays: number): Promise<void> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const p = (n: number) => String(n).padStart(2, "0");
  const cut = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())}`;
  const entries = await fs.readdir(BACKUPS_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory() && DATE_RE.test(e.name) && e.name < cut) {
      await fs.rm(path.join(BACKUPS_DIR, e.name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Run a full backup for `date` (overwrites any partial/existing folder for it). */
export async function runBackup(date = todayStr()): Promise<void> {
  const finalDir = path.join(BACKUPS_DIR, date);
  const partDir = path.join(BACKUPS_DIR, `${date}.partial`);
  await fs.rm(partDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(partDir, { recursive: true });
  try {
    await dumpDatabase(path.join(partDir, "database.sql.gz"));
    // Atomic-ish swap: remove any existing final, then rename the partial in.
    await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    await fs.rename(partDir, finalDir);
  } catch (e) {
    await fs.rm(partDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  const keep = (await getSystemSettings()).backup_retention_days || 30;
  await pruneOldBackups(keep);
}

/**
 * Lazy daily trigger (called on login). Runs in the background if today's backup
 * doesn't exist yet; a module lock prevents concurrent/duplicate runs.
 */
export function maybeRunDailyBackup(): void {
  if (running) return;
  running = (async () => {
    try {
      await fs.mkdir(BACKUPS_DIR, { recursive: true });
      const today = todayStr();
      const exists = await fs
        .stat(path.join(BACKUPS_DIR, today))
        .then(() => true)
        .catch(() => false);
      if (exists) return;
      await runBackup(today);
      console.log(`[backup] completed ${today}`);
    } catch (e) {
      console.warn("[backup] failed:", e instanceof Error ? e.message : e);
    } finally {
      running = null;
    }
  })();
}
