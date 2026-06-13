"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { BackupSettings } from "@/components/admin/BackupSettings";

type RolePerms = {
  partner_same_school: boolean;
  partner_district: boolean;
  coach_same_school: boolean;
  coach_district: boolean;
};
type MessagePermissions = { coach: RolePerms; partner: RolePerms };

type SettingsView = {
  ollama_url: string | null;
  ollama_compliance_model: string | null;
  ollama_coaching_model: string | null;
  ollama_num_ctx: number;
  rag_url: string | null;
  rag_default_threshold: number;
  rag_default_collections: string[];
  default_theme: string;
  message_permissions: MessagePermissions;
  anthropic_api_key_set: boolean;
  anthropic_api_key_from_env: boolean;
};

const THEMES = ["light", "dark"];

// Context-window ceiling options for Ollama (0 = each model's full window).
const NUM_CTX_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Auto — each model's full window" },
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
  { value: 16384, label: "16K" },
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
  { value: 131072, label: "128K" },
];

const EMPTY_PERMS: MessagePermissions = {
  coach: {
    partner_same_school: false,
    partner_district: false,
    coach_same_school: false,
    coach_district: false,
  },
  partner: {
    partner_same_school: false,
    partner_district: false,
    coach_same_school: false,
    coach_district: false,
  },
};

const PERM_ROWS: { key: keyof RolePerms; label: string }[] = [
  { key: "partner_same_school", label: "Any partner in a shared building" },
  { key: "partner_district", label: "Any partner district-wide" },
  { key: "coach_same_school", label: "Any coach in a shared building" },
  { key: "coach_district", label: "Any coach district-wide" },
];

/** Claude options for the coaching model. The Ollama coaching model is ignored when one of these is selected. */
const CLAUDE_COACHING_MODELS = [
  { id: "claude:claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude:claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude:claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

export function AdminSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [keyFromEnv, setKeyFromEnv] = useState(false);
  const [keyIsSet, setKeyIsSet] = useState(false);

  // Editable draft fields.
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [classModel, setClassModel] = useState("");
  const [coachingModel, setCoachingModel] = useState("");
  const [numCtx, setNumCtx] = useState(0);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [ragUrl, setRagUrl] = useState("");
  const [ragThreshold, setRagThreshold] = useState(0.5);
  const [defaultTheme, setDefaultTheme] = useState("light");
  const [perms, setPerms] = useState<MessagePermissions>(EMPTY_PERMS);

  // RAG collections: the live list from the server plus the selected defaults.
  const [defaultCollections, setDefaultCollections] = useState<string[]>([]);
  const [ragCollections, setRagCollections] = useState<string[]>([]);
  const [ragCollLoading, setRagCollLoading] = useState(false);
  const [ragCollError, setRagCollError] = useState<string | null>(null);

  // Live Ollama model list.
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { settings } = await apiFetch<{ settings: SettingsView }>("/api/admin/settings");
      setOllamaUrl(settings.ollama_url ?? "");
      setClassModel(settings.ollama_compliance_model ?? "");
      setCoachingModel(settings.ollama_coaching_model ?? "");
      setNumCtx(settings.ollama_num_ctx ?? 0);
      setRagUrl(settings.rag_url ?? "");
      setRagThreshold(settings.rag_default_threshold ?? 0.5);
      setDefaultCollections(settings.rag_default_collections ?? []);
      setDefaultTheme(settings.default_theme ?? "light");
      if (settings.message_permissions) setPerms(settings.message_permissions);
      setKeyFromEnv(settings.anthropic_api_key_from_env);
      setKeyIsSet(settings.anthropic_api_key_set);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const { models } = await apiFetch<{ models: string[] }>(
        "/api/admin/settings/ollama-models",
        { method: "POST", body: { ollama_url: ollamaUrl } }
      );
      setModels(models);
      if (models.length === 0) setModelsError("No models reported by the server.");
    } catch (e) {
      setModels([]);
      setModelsError(e instanceof Error ? e.message : "Failed to reach Ollama");
    } finally {
      setModelsLoading(false);
    }
  }, [ollamaUrl]);

  const loadCollections = useCallback(async () => {
    setRagCollLoading(true);
    setRagCollError(null);
    try {
      const { collections } = await apiFetch<{ collections: string[] }>(
        "/api/admin/rag/collections",
        { method: "POST", body: { rag_url: ragUrl } }
      );
      setRagCollections(collections);
      if (collections.length === 0) setRagCollError("RAGDoll reported no collections.");
    } catch (e) {
      setRagCollections([]);
      setRagCollError(e instanceof Error ? e.message : "Failed to reach RAGDoll");
    } finally {
      setRagCollLoading(false);
    }
  }, [ragUrl]);

  const toggleDefaultCollection = useCallback((name: string) => {
    setDefaultCollections((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
    );
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        ollama_url: ollamaUrl,
        ollama_compliance_model: classModel,
        ollama_coaching_model: coachingModel,
        ollama_num_ctx: numCtx,
        rag_url: ragUrl,
        rag_default_threshold: ragThreshold,
        rag_default_collections: defaultCollections,
        default_theme: defaultTheme,
        message_permissions: perms,
      };
      // Only send the key when the admin actually typed one.
      if (anthropicKey.trim() !== "") body.anthropic_api_key = anthropicKey;
      await apiFetch("/api/admin/settings", { method: "PATCH", body });
      setMessage("Saved.");
      setAnthropicKey("");
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [
    ollamaUrl,
    classModel,
    coachingModel,
    numCtx,
    anthropicKey,
    ragUrl,
    ragThreshold,
    defaultCollections,
    defaultTheme,
    perms,
    load,
  ]);

  const togglePerm = (role: "coach" | "partner", key: keyof RolePerms) =>
    setPerms((p) => ({ ...p, [role]: { ...p[role], [key]: !p[role][key] } }));

  if (loading) return <p className="text-dewey-mute">Loading settings…</p>;

  // The compliance dropdown must always show the saved value even if the
  // server isn't currently reachable.
  const classOptions = Array.from(new Set([classModel, ...models].filter(Boolean)));
  const coachingIsClaude = coachingModel.startsWith("claude:");
  // Show saved defaults even before a live load, plus anything RAGDoll reports.
  const allCollections = Array.from(
    new Set([...defaultCollections, ...ragCollections])
  ).sort((a, b) => a.localeCompare(b));

  return (
    <section className="space-y-6">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">System settings</h2>
        <p className="text-sm text-dewey-mute">
          Global configuration shared across the platform: the two-model stack
          (Ollama for compliance, Claude or Ollama for coaching), RAG, and the
          default theme.
        </p>
      </div>

      <div className="space-y-5 rounded-lg border border-dewey-border bg-dewey-surface p-5">
        {/* Ollama */}
        <div>
          <label className="dewey-label">Ollama URL</label>
          <div className="flex gap-2">
            <input
              className="dewey-input"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder="http://localhost:11434"
            />
            <button
              type="button"
              className="dewey-btn-secondary whitespace-nowrap"
              onClick={refreshModels}
              disabled={modelsLoading || !ollamaUrl.trim()}
              title="Fetch the installed model list from this server"
            >
              {modelsLoading ? "Testing…" : "Test / Refresh"}
            </button>
          </div>
          {modelsError && <p className="text-xs text-red-600 mt-1">{modelsError}</p>}
          {models.length > 0 && (
            <p className="text-xs text-dewey-mute mt-1">{models.length} models available.</p>
          )}
        </div>

        <div>
          <label className="dewey-label">Compliance and summarization model</label>
          <select
            className="dewey-input"
            value={classModel}
            onChange={(e) => setClassModel(e.target.value)}
          >
            <option value="">— none —</option>
            {classOptions.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <p className="text-xs text-dewey-mute mt-1">
            A local Ollama model used for two lightweight jobs: screening each message for safety
            before the coaching model runs, and drafting short summaries such as plan
            descriptions. Leave unset to skip screening and AI-drafted descriptions.
          </p>
        </div>

        <div>
          <label className="dewey-label">Coaching model</label>
          <select
            className="dewey-input"
            value={coachingModel}
            onChange={(e) => setCoachingModel(e.target.value)}
          >
            <option value="">— none selected —</option>
            <optgroup label="Claude (Anthropic)">
              {CLAUDE_COACHING_MODELS.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </optgroup>
            <optgroup label="Ollama (local)">
              {models.length === 0 ? (
                <option value="" disabled>Test the Ollama URL to load models</option>
              ) : (
                models.map((m) => (
                  <option key={`ollama:${m}`} value={`ollama:${m}`}>{m}</option>
                ))
              )}
            </optgroup>
            {coachingModel &&
              !CLAUDE_COACHING_MODELS.some((c) => c.id === coachingModel) &&
              !models.some((m) => `ollama:${m}` === coachingModel) &&
              !coachingModel.startsWith("claude:") && (
                <optgroup label="Currently set">
                  <option value={coachingModel}>{coachingModel}</option>
                </optgroup>
              )}
          </select>
          <p className="text-xs text-dewey-mute mt-1">
            {coachingIsClaude
              ? "A Claude model is selected — the Ollama coaching model is ignored."
              : "Select a Claude model to coach via the Anthropic API, or an Ollama model to coach locally."}
          </p>
        </div>

        <div>
          <label className="dewey-label">Ollama context window (num_ctx)</label>
          <select
            className="dewey-input"
            value={numCtx}
            onChange={(e) => setNumCtx(Number(e.target.value))}
          >
            {NUM_CTX_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="text-xs text-dewey-mute mt-1">
            Ceiling on how much chat context each Ollama model receives. &ldquo;Auto&rdquo; uses the
            model&apos;s full window; lower it if a large model runs short on VRAM under concurrent
            chats. (Ignored for Claude.)
          </p>
        </div>

        <hr className="border-dewey-border" />

        {/* Anthropic */}
        <div>
          <label className="dewey-label">Anthropic API key</label>
          <input
            type="password"
            className="dewey-input"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            placeholder={
              keyIsSet ? "•••••••• (leave blank to keep current)" : "Enter a key"
            }
            autoComplete="off"
            disabled={keyFromEnv}
          />
          <p className="text-xs text-dewey-mute mt-1">
            {keyFromEnv
              ? "Set via the ANTHROPIC_API_KEY environment variable — the stored value is ignored."
              : keyIsSet
              ? "A key is stored. Leave blank to keep it."
              : "Required to coach with a Claude model."}
          </p>
        </div>

        <hr className="border-dewey-border" />

        {/* RAG */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="dewey-label">RAGDoll URL</label>
            <input
              className="dewey-input"
              value={ragUrl}
              onChange={(e) => setRagUrl(e.target.value)}
              placeholder="http://localhost:8000"
            />
          </div>
          <div>
            <label className="dewey-label">Default similarity threshold</label>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              className="dewey-input"
              value={ragThreshold}
              onChange={(e) => setRagThreshold(parseFloat(e.target.value) || 0)}
            />
          </div>
        </div>

        {/* Default collections — populated once RAGDoll connects. */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="dewey-label mb-0">Default collections</label>
            <button
              type="button"
              className="dewey-btn-secondary"
              onClick={loadCollections}
              disabled={ragCollLoading || !ragUrl.trim()}
              title="Connect to RAGDoll and list its collections"
            >
              {ragCollLoading ? "Connecting…" : "Test / load collections"}
            </button>
          </div>
          {ragCollError && <p className="text-xs text-red-600 mb-1">{ragCollError}</p>}
          {allCollections.length === 0 ? (
            <p className="text-xs text-dewey-mute">
              Set the RAGDoll URL above, then load collections to choose defaults.
            </p>
          ) : (
            <div className="border border-dewey-border rounded-md p-2 max-h-44 overflow-y-auto space-y-1 bg-dewey-surface">
              {allCollections.map((name) => (
                <label key={name} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={defaultCollections.includes(name)}
                    onChange={() => toggleDefaultCollection(name)}
                  />
                  <span>{name}</span>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-dewey-mute mt-1">
            Used for retrieval by default. Override per user in Users below.
          </p>
        </div>

        {/* Theme */}
        <div>
          <label className="dewey-label">Default theme</label>
          <select
            className="dewey-input"
            value={defaultTheme}
            onChange={(e) => setDefaultTheme(e.target.value)}
          >
            {THEMES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        {/* Messaging permissions */}
        <div>
          <label className="dewey-label">Messaging permissions</label>
          <p className="mb-2 text-xs text-dewey-mute">
            Who coaches and partners can start a message with. Everyone can always message an admin,
            and admins can message anyone.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(["coach", "partner"] as const).map((role) => (
              <div key={role} className="rounded-md border border-dewey-border p-3">
                <div className="mb-2 text-sm font-medium capitalize text-dewey-ink">
                  A {role} can message:
                </div>
                <div className="space-y-1.5">
                  {PERM_ROWS.map((row) => (
                    <label
                      key={row.key}
                      className="flex items-center gap-2 text-sm text-dewey-ink"
                    >
                      <input
                        type="checkbox"
                        checked={perms[role][row.key]}
                        onChange={() => togglePerm(role, row.key)}
                      />
                      {row.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          className="dewey-btn-primary w-auto"
          onClick={save}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        {message && <span className="text-sm text-dewey-mute">{message}</span>}
      </div>

      <BackupSettings />
    </section>
  );
}
