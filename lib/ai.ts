import { getSystemSettings, getEffectiveAnthropicKey } from "@/lib/settings";

/**
 * Conversational completion routed to whichever model the admin selected as the
 * coaching model in System settings (system_settings.ollama_coaching_model):
 *   - "claude:<id>"  → Anthropic Messages API (key from settings/env)
 *   - "ollama:<name>" → local Ollama /api/chat at ollama_url
 * Nothing here is hardcoded to a provider.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  model: string;
}

export async function chatComplete(params: {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
}): Promise<ChatResult> {
  const settings = await getSystemSettings();
  const selected = (settings.ollama_coaching_model ?? "").trim();
  if (!selected) {
    throw new Error("No conversational model is configured in System settings.");
  }
  const sep = selected.indexOf(":");
  const backend = sep === -1 ? "" : selected.slice(0, sep).toLowerCase();
  const modelId = sep === -1 ? selected : selected.slice(sep + 1);

  if (backend === "claude") {
    const apiKey = getEffectiveAnthropicKey(settings.anthropic_api_key);
    if (!apiKey) throw new Error("No Anthropic API key is configured.");
    return callClaude({ apiKey, model: modelId, ...params });
  }
  if (backend === "ollama") {
    const url = (settings.ollama_url ?? "").trim();
    if (!url) throw new Error("No Ollama URL is configured.");
    return callOllama({ url, model: modelId, ...params });
  }
  throw new Error(
    `Unrecognized coaching model "${selected}". Select a Claude or Ollama model in System settings.`
  );
}

async function callClaude(p: {
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
}): Promise<ChatResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: p.maxTokens ?? 4096,
      system: p.system,
      messages: p.messages,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message || `Anthropic responded ${res.status}`);
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = Array.isArray(data.content)
    ? data.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
    : "";
  return { text, model: p.model };
}

async function callOllama(p: {
  url: string;
  model: string;
  system: string;
  messages: ChatMessage[];
}): Promise<ChatResult> {
  const res = await fetch(`${p.url.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: p.model,
      stream: false,
      think: false, // don't let reasoning models burn time emitting <think> tokens
      keep_alive: "30m", // keep the model warm between calls
      messages: [{ role: "system", content: p.system }, ...p.messages],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Ollama responded ${res.status}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  return { text: data.message?.content ?? "", model: p.model };
}

// ============================================================
// Compliance screen
// ============================================================

const COMPLIANCE_SYSTEM = `You are a content-safety screen for an educational coaching platform.
Decide whether the following message is appropriate to process. Block content that is harmful,
abusive, exploitative, hateful, or that seeks to misuse the tool. Ordinary professional
education/coaching requests are allowed.
Respond with ONLY a JSON object: {"allowed": true|false, "reason": "<brief reason if blocked>"}.`;

/**
 * Pre-generation compliance screen using the configured Ollama compliance model.
 * Returns { allowed } — defaults to allowed when no compliance model is set, and
 * fails open (allowed, with a logged warning) if the model errors, so a
 * misconfigured screen never hard-blocks the tool.
 */
export async function complianceCheck(text: string): Promise<{ allowed: boolean; reason?: string }> {
  const settings = await getSystemSettings();
  const model = (settings.ollama_compliance_model ?? "").trim();
  const url = (settings.ollama_url ?? "").trim();
  if (!model || !url || !text.trim()) return { allowed: true };

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        keep_alive: "30m",
        format: "json",
        messages: [
          { role: "system", content: COMPLIANCE_SYSTEM },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn("[compliance] screen error", res.status);
      return { allowed: true };
    }
    const data = (await res.json()) as { message?: { content?: string } };
    const raw = data.message?.content ?? "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return { allowed: true };
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { allowed?: unknown; reason?: unknown };
    const allowed = parsed.allowed !== false; // anything but an explicit false is allowed
    return {
      allowed,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  } catch (e) {
    console.warn("[compliance] screen failed", e instanceof Error ? e.message : e);
    return { allowed: true };
  }
}

// ============================================================
// Summarization (compliance + summarization model)
// ============================================================

const SUMMARY_SYSTEM = `You write concise descriptions of coaching plans for an educational coaching platform.
Given a plan's name and an outline of its phases and activities, write a single short paragraph
(1-3 sentences) describing what the plan is for and how it flows. Write plainly for a coach
choosing a plan. Do not invent activities that aren't listed. Respond with ONLY the description text — no labels, no quotes, no preamble.`;

/**
 * Generate a short description using the configured Ollama compliance +
 * summarization model. Throws if no model/url is configured so the caller can
 * fall back to a blank field.
 */
export async function summarizeWithComplianceModel(prompt: string): Promise<string> {
  const settings = await getSystemSettings();
  const model = (settings.ollama_compliance_model ?? "").trim();
  const url = (settings.ollama_url ?? "").trim();
  if (!model || !url) {
    throw new Error("No compliance/summarization model is configured in System settings.");
  }
  const res = await fetch(`${url.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      keep_alive: "30m",
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Ollama responded ${res.status}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  return (data.message?.content ?? "").trim();
}

// ============================================================
// Warmup
// ============================================================

/** Load one Ollama model into VRAM (empty prompt + keep_alive). Best-effort. */
async function warmOllama(url: string, model: string): Promise<{ model: string; ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: "30m", think: false }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { model, ok: false, error: body.error || `HTTP ${res.status}` };
    }
    await res.json().catch(() => ({}));
    return { model, ok: true };
  } catch (e) {
    return { model, ok: false, error: e instanceof Error ? e.message : "warmup failed" };
  }
}

/**
 * Pre-load the Ollama models in the request path (coaching, if local, and the
 * compliance screen) so the first real call doesn't pay a cold start. No-op for
 * a Claude coaching model (hosted).
 */
export async function warmCoachingModel(): Promise<{ warmed: string[] }> {
  const settings = await getSystemSettings();
  const url = (settings.ollama_url ?? "").trim();
  if (!url) return { warmed: [] };

  const targets = new Set<string>();
  const coaching = (settings.ollama_coaching_model ?? "").trim();
  if (coaching.toLowerCase().startsWith("ollama:")) {
    const name = coaching.slice(coaching.indexOf(":") + 1).trim();
    if (name) targets.add(name);
  }
  const compliance = (settings.ollama_compliance_model ?? "").trim();
  if (compliance) targets.add(compliance);

  if (targets.size === 0) return { warmed: [] };
  const results = await Promise.all(Array.from(targets).map((m) => warmOllama(url, m)));
  return { warmed: results.filter((r) => r.ok).map((r) => r.model) };
}

// ============================================================
// Streaming
// ============================================================

/** Stream a completion as text deltas from whichever coaching model is configured. */
export async function* chatStream(params: {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
}): AsyncGenerator<string, void, unknown> {
  const settings = await getSystemSettings();
  const selected = (settings.ollama_coaching_model ?? "").trim();
  if (!selected) {
    throw new Error("No conversational model is configured in System settings.");
  }
  const sep = selected.indexOf(":");
  const backend = sep === -1 ? "" : selected.slice(0, sep).toLowerCase();
  const modelId = sep === -1 ? selected : selected.slice(sep + 1);

  if (backend === "claude") {
    const apiKey = getEffectiveAnthropicKey(settings.anthropic_api_key);
    if (!apiKey) throw new Error("No Anthropic API key is configured.");
    yield* streamClaude({ apiKey, model: modelId, ...params });
    return;
  }
  if (backend === "ollama") {
    const url = (settings.ollama_url ?? "").trim();
    if (!url) throw new Error("No Ollama URL is configured.");
    yield* streamOllama({ url, model: modelId, ...params });
    return;
  }
  throw new Error(
    `Unrecognized coaching model "${selected}". Select a Claude or Ollama model in System settings.`
  );
}

async function* streamClaude(p: {
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
}): AsyncGenerator<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: p.maxTokens ?? 4096,
      system: p.system,
      messages: p.messages,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message || `Anthropic responded ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const ev = JSON.parse(payload) as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          yield ev.delta.text;
        }
      } catch {
        /* ignore partial/non-JSON SSE lines */
      }
    }
  }
}

async function* streamOllama(p: {
  url: string;
  model: string;
  system: string;
  messages: ChatMessage[];
}): AsyncGenerator<string> {
  const res = await fetch(`${p.url.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: p.model,
      stream: true,
      think: false,
      keep_alive: "30m",
      messages: [{ role: "system", content: p.system }, ...p.messages],
    }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Ollama responded ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { message?: { content?: string } };
        const piece = obj.message?.content;
        if (piece) yield piece;
      } catch {
        /* ignore non-JSON lines */
      }
    }
  }
}
