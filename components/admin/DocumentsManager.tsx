"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { pathWithBase } from "@/lib/base-path";
import { useDialog } from "@/components/DialogProvider";

type Category = { id: number; name: string; description: string | null };
type School = { id: number; name: string };
type District = { id: number; name: string; schools: School[] };
type Placement = {
  id: number;
  level: string;
  districtId: number | null;
  schoolId: number | null;
  copId: number | null;
  label: string;
};
type DocStatus = "processing" | "ready" | "error";
type DocSummary = {
  id: number;
  title: string;
  description: string | null;
  createdAt: string;
  samples: number;
  embedded: number;
  status: DocStatus;
  statusDetail: string | null;
  chunkTotal: number | null;
  categories: { id: number; name: string }[];
  placements: Placement[];
};
type Sample = {
  id: number;
  ordinal: number;
  text: string;
  context: string | null;
  source: string;
  edited: boolean;
  embedded: boolean;
};
type DocDetail = DocSummary & { filename: string | null; mime: string | null; extractedChars: number; samplesList: Sample[] };

type Cop = { id: number; subject: string | null; districtName: string | null; schoolName: string | null };

/** New placement being composed in the picker (system / district / school / CoP). */
type DraftPlacement = {
  level: "system" | "district" | "school" | "cop";
  districtId: number | null;
  schoolId: number | null;
  copId: number | null;
};

const chip = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]";

/** Compact ingest-status pill for a document row. */
function StatusChip({ doc }: { doc: DocSummary }) {
  if (doc.status === "processing") {
    const total = doc.chunkTotal;
    const label = total != null && total > 0 ? `Processing · ${doc.embedded}/${total}` : "Processing…";
    return (
      <span className={`${chip} border-amber-300 bg-amber-50 text-amber-800`}>
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-hidden />
        {label}
      </span>
    );
  }
  if (doc.status === "error") {
    return <span className={`${chip} border-red-300 bg-red-50 text-red-700`}>⚠️ Failed</span>;
  }
  return (
    <span className={`${chip} border-dewey-border ${doc.embedded === doc.samples ? "text-green-700" : "text-amber-700"}`}>
      {doc.embedded}/{doc.samples} embedded
    </span>
  );
}

export function DocumentsManager() {
  const dialog = useDialog();
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [cops, setCops] = useState<Cop[]>([]);
  const [ragOk, setRagOk] = useState(true);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const loadDocs = useCallback(async (term: string) => {
    const d = await apiFetch<{ documents: DocSummary[]; ragAvailable: boolean }>(
      `/api/admin/rag/documents${term.trim() ? `?q=${encodeURIComponent(term.trim())}` : ""}`
    );
    setDocs(d.documents);
    setRagOk(d.ragAvailable);
    setLoading(false);
  }, []);

  useEffect(() => {
    Promise.all([
      // Categories fail when the RAG tables are missing; don't lose the org pickers too.
      apiFetch<{ categories: Category[] }>("/api/admin/rag/categories").catch(() => ({ categories: [] })),
      apiFetch<{ districts: District[] }>("/api/admin/districts"),
      apiFetch<{ cops: Cop[] }>("/api/admin/cops").catch(() => ({ cops: [] })),
    ]).then(([c, o, p]) => {
      setCategories(c.categories);
      setDistricts(o.districts);
      setCops(p.cops);
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => loadDocs(q), 200);
    return () => clearTimeout(t);
  }, [q, loadDocs]);

  // While anything is still ingesting, poll so progress and the final status
  // (or error) appear on the tab without a manual refresh.
  const anyProcessing = docs.some((d) => d.status === "processing");
  useEffect(() => {
    if (!anyProcessing) return;
    const t = setInterval(() => loadDocs(q), 2500);
    return () => clearInterval(t);
  }, [anyProcessing, q, loadDocs]);

  const del = async (doc: DocSummary) => {
    if (!(await dialog.confirm(`Delete "${doc.title}" from the library?`, { title: "Delete document", confirmText: "Delete", danger: true }))) return;
    await apiFetch(`/api/admin/rag/documents/${doc.id}`, { method: "DELETE" });
    loadDocs(q);
  };
  const reembed = async (doc: DocSummary) => {
    try {
      await apiFetch(`/api/admin/rag/documents/${doc.id}/reembed`, { method: "POST" });
      loadDocs(q); // progress appears on the row via polling
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Re-embed failed");
    }
  };
  const retry = async (doc: DocSummary) => {
    try {
      await apiFetch(`/api/admin/rag/documents/${doc.id}/reprocess`, { method: "POST" });
      loadDocs(q);
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Retry failed");
    }
  };
  const reprocess = async (doc: DocSummary) => {
    if (
      !(await dialog.confirm(
        `Rebuild "${doc.title}" from the original file? This re-extracts the full text and re-chunks it, which replaces the current samples and discards any manual edits or added samples.`,
        { title: "Reprocess document", confirmText: "Reprocess" }
      ))
    )
      return;
    try {
      await apiFetch(`/api/admin/rag/documents/${doc.id}/reprocess`, { method: "POST" });
      loadDocs(q);
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Reprocess failed");
    }
  };

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Documents</h2>
        <p className="text-sm text-dewey-mute">
          The source library for retrieval. Documents are embedded once and can be placed at one or
          more units (system, district, school, or a Community of Practice); lower levels inherit
          from above.
        </p>
      </div>

      {!ragOk && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          RAG isn’t available on this server yet (pgvector or the Ollama embedding model isn’t
          configured). Documents can’t be embedded until it is.
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          className="dewey-input max-w-xs"
          placeholder="Search documents…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="dewey-btn-primary w-auto" onClick={() => setUploadOpen(true)}>
          <span aria-hidden>⬆️</span> Add document
        </button>
        <span className="text-xs text-dewey-mute">{docs.length} document{docs.length === 1 ? "" : "s"}</span>
      </div>

      {loading ? (
        <p className="text-dewey-mute">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="py-4 text-sm text-dewey-mute">No documents yet. Add one to build the library.</p>
      ) : (
        <ul className="space-y-2">
          {docs.map((d) => (
            <li key={d.id} className="rounded-lg border border-dewey-border bg-dewey-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setDetailId(d.id)}>
                  <div className="font-medium">{d.title}</div>
                  {d.description && <div className="text-xs text-dewey-mute line-clamp-2">{d.description}</div>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {d.categories.map((c) => (
                      <span key={c.id} className={`${chip} border-dewey-accent/40 bg-dewey-accent/5 text-dewey-accent`}>
                        {c.name}
                      </span>
                    ))}
                    {d.placements.map((p) => (
                      <span key={p.id} className={`${chip} border-dewey-border bg-dewey-surface-2 text-dewey-mute`}>
                        📍 {p.label}
                      </span>
                    ))}
                    <StatusChip doc={d} />
                  </div>
                  {(d.status === "processing" || d.status === "error") && d.statusDetail && (
                    <div className={`mt-1 text-xs ${d.status === "error" ? "text-red-700" : "text-dewey-mute"}`}>
                      {d.statusDetail}
                    </div>
                  )}
                  {d.status === "ready" && d.statusDetail?.includes("⚠️") && (
                    <div className="mt-1 text-xs text-amber-700">{d.statusDetail}</div>
                  )}
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {d.status === "error" ? (
                    <button type="button" className="text-xs text-dewey-accent hover:underline" onClick={() => retry(d)}>
                      Retry
                    </button>
                  ) : d.status === "ready" ? (
                    <>
                      <button
                        type="button"
                        className="text-xs text-dewey-accent hover:underline"
                        onClick={() => reembed(d)}
                        title="Re-embed the existing samples with the current settings (regenerates contextual headers). Keeps sample text and manual edits."
                      >
                        Re-embed
                      </button>
                      <button
                        type="button"
                        className="text-xs text-dewey-accent hover:underline"
                        onClick={() => reprocess(d)}
                        title="Rebuild from the original file: re-extract the full text and re-chunk. Changes the sample set and discards manual edits."
                      >
                        Reprocess
                      </button>
                    </>
                  ) : null}
                  <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => del(d)}>
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {uploadOpen && (
        <UploadModal
          categories={categories}
          districts={districts}
          cops={cops}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false);
            loadDocs(q);
          }}
        />
      )}
      {detailId != null && (
        <DetailModal
          docId={detailId}
          categories={categories}
          districts={districts}
          cops={cops}
          onClose={() => {
            setDetailId(null);
            loadDocs(q);
          }}
        />
      )}
    </section>
  );
}

// ---- Placement picker (shared) ---------------------------------------------

function PlacementRow({
  value,
  districts,
  cops,
  onChange,
  onRemove,
}: {
  value: DraftPlacement;
  districts: District[];
  cops: Cop[];
  onChange: (v: DraftPlacement) => void;
  onRemove: () => void;
}) {
  const schools = districts.find((d) => d.id === value.districtId)?.schools ?? [];
  const copLabel = (c: Cop) =>
    `${c.subject || `Community #${c.id}`}${c.schoolName ? ` · ${c.schoolName}` : c.districtName ? ` · ${c.districtName}` : ""}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="dewey-input w-auto"
        value={value.level}
        onChange={(e) =>
          onChange({ level: e.target.value as DraftPlacement["level"], districtId: null, schoolId: null, copId: null })
        }
      >
        <option value="system">System-wide</option>
        <option value="district">District</option>
        <option value="school">School</option>
        <option value="cop">Community of Practice</option>
      </select>
      {(value.level === "district" || value.level === "school") && (
        <select
          className="dewey-input w-auto"
          value={value.districtId ?? ""}
          onChange={(e) => onChange({ ...value, districtId: Number(e.target.value) || null, schoolId: null })}
        >
          <option value="">Choose district…</option>
          {districts.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      )}
      {value.level === "school" && value.districtId != null && (
        <select
          className="dewey-input w-auto"
          value={value.schoolId ?? ""}
          onChange={(e) => onChange({ ...value, schoolId: Number(e.target.value) || null })}
        >
          <option value="">Choose school…</option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      )}
      {value.level === "cop" && (
        <select
          className="dewey-input w-auto"
          value={value.copId ?? ""}
          onChange={(e) => onChange({ ...value, copId: Number(e.target.value) || null })}
        >
          <option value="">Choose community…</option>
          {cops.map((c) => (
            <option key={c.id} value={c.id}>{copLabel(c)}</option>
          ))}
        </select>
      )}
      <button type="button" className="text-xs text-red-700 hover:underline" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}

function validPlacements(drafts: DraftPlacement[]): DraftPlacement[] {
  return drafts.filter(
    (p) =>
      p.level === "system" ||
      (p.level === "district" && p.districtId != null) ||
      (p.level === "school" && p.districtId != null && p.schoolId != null) ||
      (p.level === "cop" && p.copId != null)
  );
}

// ---- Upload modal -----------------------------------------------------------

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Matches the ingest route's limit.
const INGESTABLE = /\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods|rtf|txt|md|markdown|csv|tsv|json|log|html?|png|jpe?g|gif|webp|bmp|tiff?)$/i;

/** Split a chosen folder into files to ingest and files skipped (with why). */
function sortFolderFiles(list: FileList | null): { ready: File[]; skipped: string[] } {
  const ready: File[] = [];
  const skipped: string[] = [];
  for (const f of Array.from(list ?? [])) {
    const path = f.webkitRelativePath || f.name;
    // System files, hidden folders, and Office lock files aren't documents.
    if (path.split("/").some((part) => part.startsWith(".") || part.startsWith("~$"))) continue;
    if (/^(thumbs\.db|desktop\.ini)$/i.test(f.name)) continue;
    if (!INGESTABLE.test(f.name)) skipped.push(`${path} (unsupported type)`);
    else if (f.size > MAX_UPLOAD_BYTES) skipped.push(`${path} (over 25 MB)`);
    else ready.push(f);
  }
  return { ready, skipped };
}

function CategoryChips({
  categories,
  isOn,
  onToggle,
}: {
  categories: Category[];
  isOn: (id: number) => boolean;
  onToggle: (id: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {categories.map((c) => {
        const on = isOn(c.id);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onToggle(c.id)}
            className={`${chip} ${on ? "border-dewey-accent bg-dewey-accent/10 text-dewey-accent" : "border-dewey-border text-dewey-mute"}`}
            title={c.description ?? undefined}
          >
            {on ? "✓ " : ""}{c.name}
          </button>
        );
      })}
    </div>
  );
}

function UploadModal({
  categories,
  districts,
  cops,
  onClose,
  onDone,
}: {
  categories: Category[];
  districts: District[];
  cops: Cop[];
  onClose: () => void;
  onDone: () => void;
}) {
  const dialog = useDialog();
  const [title, setTitle] = useState("");
  const [catIds, setCatIds] = useState<number[]>([]);
  const [placements, setPlacements] = useState<DraftPlacement[]>([{ level: "system", districtId: null, schoolId: null, copId: null }]);
  const [files, setFiles] = useState<File[]>([]);
  // Categories for each entry in `files`, used when uploading more than one.
  const [fileCats, setFileCats] = useState<number[][]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"file" | "folder" | "text" | "url">("file");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(0);

  const usesFiles = mode === "file" || mode === "folder";
  const isBatch = mode === "folder" || (mode === "file" && files.length > 1);

  const chooseFiles = (chosen: File[]) => {
    setFiles(chosen);
    setFileCats(chosen.map(() => [...catIds]));
  };

  const switchMode = (next: typeof mode) => {
    setMode(next);
    chooseFiles([]);
    setSkipped([]);
  };

  const toggleFileCat = (index: number, id: number) =>
    setFileCats((cur) =>
      cur.map((ids, i) => (i !== index ? ids : ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
    );

  const onAllFiles = (id: number) => fileCats.length > 0 && fileCats.every((ids) => ids.includes(id));

  const toggleCatForAll = (id: number) => {
    const remove = onAllFiles(id);
    setFileCats((cur) => cur.map((ids) => (remove ? ids.filter((x) => x !== id) : ids.includes(id) ? ids : [...ids, id])));
  };

  const submit = async () => {
    const places = validPlacements(placements);
    if (places.length === 0) return dialog.alert("Add at least one valid placement.");
    if (mode === "file" && files.length === 0) return dialog.alert("Choose a file, or switch to pasting text.");
    if (mode === "folder" && files.length === 0) return dialog.alert("Choose a folder with at least one supported file.");
    if (mode === "text" && !text.trim()) return dialog.alert("Paste some text, or switch to a file.");
    if (mode === "url" && !/^https?:\/\/\S+/i.test(url.trim())) return dialog.alert("Enter a valid http(s) URL.");
    setBusy(true);

    const send = async (docTitle: string, file: File | null, docCats: number[]) => {
      const form = new FormData();
      form.append("title", docTitle);
      form.append("categoryIds", JSON.stringify(docCats));
      form.append("placements", JSON.stringify(places));
      if (file) form.append("file", file);
      if (mode === "text") form.append("text", text);
      if (mode === "url") form.append("url", url.trim());
      const res = await fetch(pathWithBase("/api/admin/rag/documents"), { method: "POST", body: form });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Ingest failed");
    };

    if (isBatch) {
      // One request at a time, so a large folder doesn't flood the server. A failed
      // file doesn't stop the rest; failures are listed once the batch is done.
      const failed: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setSent(i + 1);
        try {
          await send(files[i].name, files[i], fileCats[i] ?? []);
        } catch (e) {
          failed.push(`${files[i].name}: ${e instanceof Error ? e.message : "Couldn't start the upload"}`);
        }
      }
      if (failed.length > 0) {
        await dialog.alert(`${failed.length} of ${files.length} files couldn't be added:\n\n${failed.join("\n")}`);
      }
      onDone();
      return;
    }

    try {
      await send(title.trim() || (files[0]?.name ?? ""), usesFiles ? files[0] : null, catIds);
      // Extraction + embedding continue in the background; close now and let the
      // list show progress and any error on the new document's row.
      onDone();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't start the upload");
      setBusy(false);
    }
  };

  return (
    <Modal title="Add document" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 text-xs">
          <button type="button" className={`rounded-full px-3 py-1 ${mode === "file" ? "bg-dewey-accent/10 text-dewey-accent" : "text-dewey-mute"}`} onClick={() => switchMode("file")}>
            Upload files
          </button>
          <button type="button" className={`rounded-full px-3 py-1 ${mode === "folder" ? "bg-dewey-accent/10 text-dewey-accent" : "text-dewey-mute"}`} onClick={() => switchMode("folder")}>
            Upload a folder
          </button>
          <button type="button" className={`rounded-full px-3 py-1 ${mode === "text" ? "bg-dewey-accent/10 text-dewey-accent" : "text-dewey-mute"}`} onClick={() => switchMode("text")}>
            Paste text
          </button>
          <button type="button" className={`rounded-full px-3 py-1 ${mode === "url" ? "bg-dewey-accent/10 text-dewey-accent" : "text-dewey-mute"}`} onClick={() => switchMode("url")}>
            From URL
          </button>
        </div>
        {mode === "file" ? (
          <input type="file" multiple className="dewey-input" onChange={(e) => chooseFiles(Array.from(e.target.files ?? []))} />
        ) : mode === "folder" ? (
          <div>
            <input
              type="file"
              className="dewey-input"
              {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
              onChange={(e) => {
                const { ready, skipped: left } = sortFolderFiles(e.target.files);
                chooseFiles(ready);
                setSkipped(left);
              }}
            />
            <p className="mt-1 text-xs text-dewey-mute">
              Includes subfolders. {files.length} {files.length === 1 ? "file" : "files"} ready
              {skipped.length > 0 ? `, ${skipped.length} skipped` : ""}.
            </p>
            {skipped.length > 0 && (
              <details className="mt-1 text-xs text-dewey-mute">
                <summary className="cursor-pointer">Show skipped files</summary>
                <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
                  {skipped.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : mode === "text" ? (
          <textarea className="dewey-input min-h-[120px]" placeholder="Paste the document text…" value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <div>
            <input className="dewey-input" placeholder="https://en.wikipedia.org/wiki/…" value={url} onChange={(e) => setUrl(e.target.value)} />
            <p className="mt-1 text-xs text-dewey-mute">The page is fetched and ingested; citations link back to it.</p>
          </div>
        )}
        {isBatch ? (
          <p className="text-xs text-dewey-mute">Each document is titled from its file name and gets its own automatic description; you can edit them afterward. Categories are set per file; the placements below apply to all of them.</p>
        ) : (
          <div>
            <label className="dewey-label">Title</label>
            <input className="dewey-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={files[0]?.name ?? "Document title"} />
            <p className="mt-1 text-xs text-dewey-mute">A description is drafted automatically from the document; you can edit it afterward.</p>
          </div>
        )}
        <div>
          <label className="dewey-label">Categories</label>
          {isBatch ? (
            files.length > 0 && (
              <div className="space-y-3">
                <div>
                  <p className="mb-1 text-xs font-medium">All files</p>
                  <CategoryChips categories={categories} isOn={onAllFiles} onToggle={toggleCatForAll} />
                </div>
                <ul className="max-h-64 space-y-3 overflow-y-auto border-t border-dewey-border pt-3">
                  {files.map((f, i) => (
                    <li key={`${f.webkitRelativePath || f.name}-${i}`}>
                      <p className="mb-1 break-words text-xs font-medium">{f.webkitRelativePath || f.name}</p>
                      <CategoryChips
                        categories={categories}
                        isOn={(id) => (fileCats[i] ?? []).includes(id)}
                        onToggle={(id) => toggleFileCat(i, id)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <CategoryChips
              categories={categories}
              isOn={(id) => catIds.includes(id)}
              onToggle={(id) => setCatIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
            />
          )}
        </div>
        <div>
          <label className="dewey-label">Placements (where it's available)</label>
          <div className="space-y-2">
            {placements.map((p, i) => (
              <PlacementRow
                key={i}
                value={p}
                districts={districts}
                cops={cops}
                onChange={(v) => setPlacements((cur) => cur.map((x, j) => (j === i ? v : x)))}
                onRemove={() => setPlacements((cur) => cur.filter((_, j) => j !== i))}
              />
            ))}
            <button type="button" className="text-xs text-dewey-accent hover:underline" onClick={() => setPlacements((c) => [...c, { level: "system", districtId: null, schoolId: null, copId: null }])}>
              + Add placement
            </button>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="dewey-btn-secondary px-5 py-2.5" onClick={onClose} disabled={busy}>
            <span aria-hidden>✕</span> Cancel
          </button>
          <button type="button" className="dewey-btn-primary w-auto" onClick={submit} disabled={busy}>
            <span aria-hidden>⬆️</span>{" "}
            {busy
              ? isBatch
                ? `Sending ${sent} of ${files.length}…`
                : "Starting…"
              : isBatch
                ? `Add ${files.length} ${files.length === 1 ? "document" : "documents"}`
                : "Add document"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- Detail modal -----------------------------------------------------------

function DetailModal({
  docId,
  categories,
  districts,
  cops,
  onClose,
}: {
  docId: number;
  categories: Category[];
  districts: District[];
  cops: Cop[];
  onClose: () => void;
}) {
  const dialog = useDialog();
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // The title/description last saved, to tell when there are unsaved edits.
  const [saved, setSaved] = useState({ title: "", description: "" });
  const [metaStatus, setMetaStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [catIds, setCatIds] = useState<number[]>([]);
  const [newPlacement, setNewPlacement] = useState<DraftPlacement>({ level: "system", districtId: null, schoolId: null, copId: null });
  const [newSample, setNewSample] = useState("");

  const loaded = useRef(false);
  const load = useCallback(async () => {
    const d = await apiFetch<{ document: DocDetail }>(`/api/admin/rag/documents/${docId}`);
    setDoc(d.document);
    // Fill the title/description boxes only on first load, so a reload after a
    // placement or sample change keeps unsaved edits.
    if (!loaded.current) {
      loaded.current = true;
      setTitle(d.document.title);
      setDescription(d.document.description ?? "");
    }
    setSaved({ title: d.document.title, description: d.document.description ?? "" });
    setCatIds(d.document.categories.map((c) => c.id));
  }, [docId]);
  const metaDirty = title !== saved.title || description !== saved.description;
  useEffect(() => {
    load();
  }, [load]);

  // Title and description save only from the Save button (a change re-embeds
  // the document). Categories save on each toggle, sending only the categories
  // so an unsaved title/description edit isn't saved along with them.
  const saveDetails = async () => {
    const next = { title, description };
    setMetaStatus("saving");
    try {
      await apiFetch(`/api/admin/rag/documents/${docId}`, { method: "PATCH", body: next });
      setSaved(next);
      setMetaStatus("saved");
    } catch (e) {
      setMetaStatus("error");
      dialog.alert(e instanceof Error ? e.message : "Couldn't save the document details");
    }
  };
  const saveCategories = async (categoryIds: number[]) => {
    try {
      await apiFetch(`/api/admin/rag/documents/${docId}`, { method: "PATCH", body: { categoryIds } });
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Couldn't save the categories");
    }
  };
  // Closing with unsaved title/description edits asks first.
  const close = async () => {
    if (
      metaDirty &&
      !(await dialog.confirm("Discard your unsaved title and description changes?", {
        title: "Unsaved changes",
        confirmText: "Discard",
        danger: true,
      }))
    )
      return;
    onClose();
  };
  const addPlacement = async () => {
    const [v] = validPlacements([newPlacement]);
    if (!v) return dialog.alert("Choose a valid placement.");
    await apiFetch(`/api/admin/rag/documents/${docId}/placements`, { method: "POST", body: v });
    setNewPlacement({ level: "system", districtId: null, schoolId: null, copId: null });
    load();
  };
  const removePlacement = async (id: number) => {
    await apiFetch(`/api/admin/rag/placements/${id}`, { method: "DELETE" });
    load();
  };
  const addSampleFn = async () => {
    if (!newSample.trim()) return;
    await apiFetch(`/api/admin/rag/documents/${docId}/samples`, { method: "POST", body: { text: newSample } });
    setNewSample("");
    load();
  };

  return (
    <Modal title={doc?.title ?? "Document"} onClose={close} wide>
      {!doc ? (
        <p className="text-dewey-mute">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="dewey-label">Title</label>
              <input
                className="dewey-input"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setMetaStatus("idle");
                }}
              />
            </div>
            <div>
              <label className="dewey-label">Categories</label>
              <div className="flex flex-wrap gap-2">
                {categories.map((c) => {
                  const on = catIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        const next = on ? catIds.filter((x) => x !== c.id) : [...catIds, c.id];
                        setCatIds(next);
                        saveCategories(next);
                      }}
                      className={`${chip} ${on ? "border-dewey-accent bg-dewey-accent/10 text-dewey-accent" : "border-dewey-border text-dewey-mute"}`}
                    >
                      {on ? "✓ " : ""}{c.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div>
            <label className="dewey-label">Description</label>
            <textarea
              className="dewey-input min-h-[50px]"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setMetaStatus("idle");
              }}
            />
            <div className="mt-1.5 flex items-center gap-3">
              <button
                type="button"
                className="dewey-btn-secondary"
                onClick={saveDetails}
                disabled={!metaDirty || metaStatus === "saving"}
              >
                <span aria-hidden>💾</span> {metaStatus === "saving" ? "Saving…" : "Save"}
              </button>
              <span className="text-xs text-dewey-mute">
                {metaDirty
                  ? "Unsaved changes"
                  : metaStatus === "saved"
                  ? "✓ Saved"
                  : "Title and description are part of search; saving a change re-embeds this document's samples."}
              </span>
            </div>
          </div>

          <div>
            <label className="dewey-label">Placements</label>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {doc.placements.map((p) => (
                <span key={p.id} className={`${chip} border-dewey-border bg-dewey-surface-2`}>
                  📍 {p.label}
                  <button type="button" className="text-red-600" onClick={() => removePlacement(p.id)} title="Remove">✕</button>
                </span>
              ))}
              {doc.placements.length === 0 && <span className="text-xs text-dewey-mute">No placements — this document isn't visible anywhere.</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PlacementRow value={newPlacement} districts={districts} cops={cops} onChange={setNewPlacement} onRemove={() => setNewPlacement({ level: "system", districtId: null, schoolId: null, copId: null })} />
              <button type="button" className="dewey-btn-secondary" onClick={addPlacement}>
                <span aria-hidden>➕</span> Add here too
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-3">
              <label className="dewey-label mb-0">Samples ({doc.embedded}/{doc.samples} embedded)</label>
              <span className="flex items-center gap-3 text-xs text-dewey-mute">
                <span>Extracted text: {doc.extractedChars.toLocaleString()} chars</span>
                <a
                  className="text-dewey-accent hover:underline"
                  href={pathWithBase(`/api/admin/rag/documents/${docId}/export`)}
                  download
                >
                  ⬇︎ Download export
                </a>
              </span>
            </div>
            <div className="space-y-2">
              {doc.samplesList.map((s) => (
                <SampleRow key={s.id} sample={s} onChanged={load} />
              ))}
            </div>
            <div className="mt-3 rounded-md border border-dashed border-dewey-border p-2">
              <textarea
                className="dewey-input min-h-[60px]"
                placeholder="Add a new sample (a passage you want retrievable)…"
                value={newSample}
                onChange={(e) => setNewSample(e.target.value)}
              />
              <div className="mt-1 flex justify-end">
                <button type="button" className="dewey-btn-secondary" onClick={addSampleFn} disabled={!newSample.trim()}>
                  <span aria-hidden>➕</span> Add sample
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SampleRow({ sample, onChanged }: { sample: Sample; onChanged: () => void }) {
  const dialog = useDialog();
  const [text, setText] = useState(sample.text);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await apiFetch(`/api/admin/rag/samples/${sample.id}`, { method: "PATCH", body: { text } });
      setEditing(false);
      onChanged();
    } catch (e) {
      dialog.alert(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!(await dialog.confirm("Delete this sample?", { title: "Delete sample", confirmText: "Delete", danger: true }))) return;
    await apiFetch(`/api/admin/rag/samples/${sample.id}`, { method: "DELETE" });
    onChanged();
  };

  return (
    <div className="rounded-md border border-dewey-border bg-dewey-surface-2 p-2">
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-dewey-mute">
        <span>#{sample.ordinal + 1}</span>
        {sample.source === "manual" && <span className="text-dewey-accent">manual</span>}
        {sample.edited && <span>edited</span>}
        <span className={sample.embedded ? "text-green-700" : "text-amber-700"}>{sample.embedded ? "embedded" : "not embedded"}</span>
        <span className="ml-auto flex gap-2">
          {editing ? (
            <>
              <button type="button" className="text-dewey-accent hover:underline" onClick={save} disabled={busy}>Save</button>
              <button type="button" className="hover:underline" onClick={() => { setText(sample.text); setEditing(false); }}>Cancel</button>
            </>
          ) : (
            <button type="button" className="text-dewey-accent hover:underline" onClick={() => setEditing(true)}>Edit</button>
          )}
          <button type="button" className="text-red-600 hover:underline" onClick={del}>Delete</button>
        </span>
      </div>
      {sample.context && !editing && (
        <p className="mb-1 rounded bg-dewey-accent/5 px-1.5 py-1 text-[11px] italic text-dewey-mute line-clamp-3">
          <span className="not-italic font-medium">Context: </span>{sample.context}
        </p>
      )}
      {editing ? (
        <textarea className="dewey-input min-h-[80px]" value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className="whitespace-pre-wrap text-xs text-dewey-ink line-clamp-4">{sample.text}</p>
      )}
    </div>
  );
}

// ---- Modal shell ------------------------------------------------------------

function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div
        className={`my-8 w-full ${wide ? "max-w-3xl" : "max-w-xl"} rounded-lg border border-dewey-border bg-dewey-surface p-5 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-dewey-ink">{title}</h3>
          <button type="button" className="text-dewey-mute hover:text-dewey-ink" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
