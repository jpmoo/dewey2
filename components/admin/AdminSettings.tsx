"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type SettingsView = {
  ollama_url: string | null;
  ollama_classification_model: string | null;
  ollama_coaching_model: string | null;
  rag_url: string | null;
  rag_default_threshold: number;
  rag_default_collections: string[];
  default_theme: string;
  anthropic_api_key_set: boolean;
  anthropic_api_key_from_env: boolean;
};

const THEMES = ["light", "dark"];

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
  const [anthropicKey, setAnthropicKey] = useState("");
  const [ragUrl, setRagUrl] = useState("");
  const [ragThreshold, setRagThreshold] = useState(0.5);
  const [defaultTheme, setDefaultTheme] = useState("light");

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
      setClassModel(settings.ollama_classification_model ?? "");
      setCoachingModel(settings.ollama_coaching_model ?? "");
      setRagUrl(settings.rag_url ?? "");
      setRagThreshold(settings.rag_default_threshold ?? 0.5);
      setDefaultCollections(settings.rag_default_collections ?? []);
      setDefaultTheme(settings.default_theme ?? "light");
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
        ollama_classification_model: classModel,
        ollama_coaching_model: coachingModel,
        rag_url: ragUrl,
        rag_default_threshold: ragThreshold,
        rag_default_collections: defaultCollections,
        default_theme: defaultTheme,
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
    anthropicKey,
    ragUrl,
    ragThreshold,
    defaultCollections,
    defaultTheme,
    load,
  ]);

  if (loading) return <p className="text-dewey-mute">Loading settings…</p>;

  // The classification dropdown must always show the saved value even if the
  // server isn't currently reachable.
  const classOptions = Array.from(new Set([classModel, ...models].filter(Boolean)));
  const coachingIsClaude = coachingModel.startsWith("claude:");
  // Show saved defaults even before a live load, plus anything RAGDoll reports.
  const allCollections = Array.from(
    new Set([...defaultCollections, ...ragCollections])
  ).sort((a, b) => a.localeCompare(b));

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">System settings</h2>
        <p className="text-sm text-dewey-mute">
          Global configuration shared across the platform: the two-model stack
          (Ollama for routing/compliance, Claude for coaching), RAG, and the
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
          <label className="dewey-label">Classification / summarization model</label>
          <select
            className="dewey-input"
            value={classModel}
            onChange={(e) => setClassModel(e.target.value)}
          >
            <option value="">— none selected —</option>
            {classOptions.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <p className="text-xs text-dewey-mute mt-1">
            Used for arc classification, compliance screening, and summarization.
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
    </section>
  );
}
