"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
type DocDetail = DocSummary & { filename: string | null; mime: string | null; samplesList: Sample[] };

/** New placement being composed in the picker (system / district / school). */
type DraftPlacement = { level: "system" | "district" | "school"; districtId: number | null; schoolId: number | null };

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
      apiFetch<{ categories: Category[] }>("/api/admin/rag/categories"),
      apiFetch<{ districts: District[] }>("/api/admin/districts"),
    ]).then(([c, o]) => {
      setCategories(c.categories);
      setDistricts(o.districts);
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
          more units (system, district, or school); lower levels inherit from above.
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
  onChange,
  onRemove,
}: {
  value: DraftPlacement;
  districts: District[];
  onChange: (v: DraftPlacement) => void;
  onRemove: () => void;
}) {
  const schools = districts.find((d) => d.id === value.districtId)?.schools ?? [];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="dewey-input w-auto"
        value={value.level}
        onChange={(e) => onChange({ level: e.target.value as DraftPlacement["level"], districtId: null, schoolId: null })}
      >
        <option value="system">System-wide</option>
        <option value="district">District</option>
        <option value="school">School</option>
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
      (p.level === "school" && p.districtId != null && p.schoolId != null)
  );
}

// ---- Upload modal -----------------------------------------------------------

function UploadModal({
  categories,
  districts,
  onClose,
  onDone,
}: {
  categories: Category[];
  districts: District[];
  onClose: () => void;
  onDone: () => void;
}) {
  const dialog = useDialog();
  const [title, setTitle] = useState("");
  const [catIds, setCatIds] = useState<number[]>([]);
  const [placements, setPlacements] = useState<DraftPlacement[]>([{ level: "system", districtId: null, schoolId: null }]);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"file" | "text">("file");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const places = validPlacements(placements);
    if (places.length === 0) return dialog.alert("Add at least one valid placement.");
    if (mode === "file" && !file) return dialog.alert("Choose a file, or switch to pasting text.");
    if (mode === "text" && !text.trim()) return dialog.alert("Paste some text, or switch to a file.");
    setBusy(true);
    try {
      const form = new FormData();
      form.append("title", title.trim() || (file?.name ?? ""));
      form.append("categoryIds", JSON.stringify(catIds));
      form.append("placements", JSON.stringify(places));
      if (mode === "file" && file) form.append("file", file);
      if (mode === "text") form.append("text", text);
      const res = await fetch(pathWithBase("/api/admin/rag/documents"), { method: "POST", body: form });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Ingest failed");
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
        <div className="flex gap-2 text-xs">
          <button type="button" className={`rounded-full px-3 py-1 ${mode === "file" ? "bg-dewey-accent/10 text-dewey-accent" : "text-dewey-mute"}`} onClick={() => setMode("file")}>
            Upload a file
          </button>
          <button type="button" className={`rounded-full px-3 py-1 ${mode === "text" ? "bg-dewey-accent/10 text-dewey-accent" : "text-dewey-mute"}`} onClick={() => setMode("text")}>
            Paste text
          </button>
        </div>
        {mode === "file" ? (
          <input type="file" className="dewey-input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        ) : (
          <textarea className="dewey-input min-h-[120px]" placeholder="Paste the document text…" value={text} onChange={(e) => setText(e.target.value)} />
        )}
        <div>
          <label className="dewey-label">Title</label>
          <input className="dewey-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={file?.name ?? "Document title"} />
          <p className="mt-1 text-xs text-dewey-mute">A description is drafted automatically from the document; you can edit it afterward.</p>
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
                  onClick={() => setCatIds((cur) => (on ? cur.filter((x) => x !== c.id) : [...cur, c.id]))}
                  className={`${chip} ${on ? "border-dewey-accent bg-dewey-accent/10 text-dewey-accent" : "border-dewey-border text-dewey-mute"}`}
                  title={c.description ?? undefined}
                >
                  {on ? "✓ " : ""}{c.name}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="dewey-label">Placements (where it's available)</label>
          <div className="space-y-2">
            {placements.map((p, i) => (
              <PlacementRow
                key={i}
                value={p}
                districts={districts}
                onChange={(v) => setPlacements((cur) => cur.map((x, j) => (j === i ? v : x)))}
                onRemove={() => setPlacements((cur) => cur.filter((_, j) => j !== i))}
              />
            ))}
            <button type="button" className="text-xs text-dewey-accent hover:underline" onClick={() => setPlacements((c) => [...c, { level: "system", districtId: null, schoolId: null }])}>
              + Add placement
            </button>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="dewey-btn-secondary px-5 py-2.5" onClick={onClose} disabled={busy}>
            <span aria-hidden>✕</span> Cancel
          </button>
          <button type="button" className="dewey-btn-primary w-auto" onClick={submit} disabled={busy}>
            <span aria-hidden>⬆️</span> {busy ? "Starting…" : "Add document"}
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
  onClose,
}: {
  docId: number;
  categories: Category[];
  districts: District[];
  onClose: () => void;
}) {
  const dialog = useDialog();
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [catIds, setCatIds] = useState<number[]>([]);
  const [newPlacement, setNewPlacement] = useState<DraftPlacement>({ level: "system", districtId: null, schoolId: null });
  const [newSample, setNewSample] = useState("");

  const load = useCallback(async () => {
    const d = await apiFetch<{ document: DocDetail }>(`/api/admin/rag/documents/${docId}`);
    setDoc(d.document);
    setTitle(d.document.title);
    setDescription(d.document.description ?? "");
    setCatIds(d.document.categories.map((c) => c.id));
  }, [docId]);
  useEffect(() => {
    load();
  }, [load]);

  const saveMeta = async () => {
    await apiFetch(`/api/admin/rag/documents/${docId}`, {
      method: "PATCH",
      body: { title, description, categoryIds: catIds },
    });
    load();
  };
  const addPlacement = async () => {
    const [v] = validPlacements([newPlacement]);
    if (!v) return dialog.alert("Choose a valid placement.");
    await apiFetch(`/api/admin/rag/documents/${docId}/placements`, { method: "POST", body: v });
    setNewPlacement({ level: "system", districtId: null, schoolId: null });
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
    <Modal title={doc?.title ?? "Document"} onClose={onClose} wide>
      {!doc ? (
        <p className="text-dewey-mute">Loading…</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="dewey-label">Title</label>
              <input className="dewey-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveMeta} />
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
                      }}
                      onMouseLeave={saveMeta}
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
            <textarea className="dewey-input min-h-[50px]" value={description} onChange={(e) => setDescription(e.target.value)} onBlur={saveMeta} />
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
              <PlacementRow value={newPlacement} districts={districts} onChange={setNewPlacement} onRemove={() => setNewPlacement({ level: "system", districtId: null, schoolId: null })} />
              <button type="button" className="dewey-btn-secondary" onClick={addPlacement}>
                <span aria-hidden>➕</span> Add here too
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="dewey-label mb-0">Samples ({doc.embedded}/{doc.samples} embedded)</label>
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
