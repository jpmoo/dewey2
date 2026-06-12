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
