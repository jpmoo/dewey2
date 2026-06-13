"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { pathWithBase } from "@/lib/base-path";
import { useDialog } from "@/components/DialogProvider";

type BackupInfo = { date: string; sizeBytes: number };

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Daily on-server backups: retention setting, a list of existing backups, and a
 * "Back up now" action. The automatic daily backup runs on login.
 */
export function BackupSettings() {
  const dialog = useDialog();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [retention, setRetention] = useState(30);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<{ backups: BackupInfo[]; retentionDays: number }>(
        "/api/admin/backup"
      );
      setBackups(d.backups ?? []);
      setRetention(d.retentionDays ?? 30);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveRetention = async () => {
    setSaving(true);
    try {
      const res = await fetch(pathWithBase("/api/admin/backup"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retentionDays: retention }),
      });
      if (!res.ok) throw new Error();
      load();
    } catch {
      dialog.alert("Couldn't save the retention setting.");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await fetch(pathWithBase("/api/admin/backup"), { method: "POST" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error || "Backup failed");
      }
      const d = (await res.json()) as { backups: BackupInfo[] };
      setBackups(d.backups ?? []);
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Backup failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="rounded-lg border border-dewey-border bg-dewey-surface p-4">
      <h3 className="text-sm font-semibold text-dewey-ink">Backups</h3>
      <p className="mt-1 text-xs text-dewey-mute">
        Once per day (checked at login) the server saves a full database dump (which includes all
        uploaded files) to <code>backups/&lt;date&gt;/</code> in the project root.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="dewey-label">Days to keep</span>
          <input
            type="number"
            min={1}
            className="dewey-input w-28"
            value={retention}
            onChange={(e) => setRetention(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className="dewey-btn-secondary w-auto"
          onClick={saveRetention}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="dewey-btn-primary w-auto"
          onClick={runNow}
          disabled={running}
        >
          {running ? "Backing up…" : "Back up now"}
        </button>
      </div>

      <div className="mt-4">
        <p className="mb-1 text-xs font-medium text-dewey-mute">
          Existing backups{backups.length ? ` (${backups.length})` : ""}
        </p>
        {loading ? (
          <p className="text-xs text-dewey-mute">Loading…</p>
        ) : backups.length === 0 ? (
          <p className="text-xs text-dewey-mute">No backups yet.</p>
        ) : (
          <ul className="max-h-48 divide-y divide-dewey-border overflow-y-auto rounded border border-dewey-border">
            {backups.map((b) => (
              <li key={b.date} className="flex items-center justify-between px-3 py-1.5 text-sm">
                <span className="text-dewey-ink">{b.date}</span>
                <span className="text-xs text-dewey-mute">{fmtSize(b.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
