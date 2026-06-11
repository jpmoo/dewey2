import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { getSystemSettings } from "@/lib/settings";

/**
 * Fetch the live model list from an Ollama server (GET {url}/api/tags). The URL
 * may be supplied in the body (so the admin can test a URL before saving it);
 * otherwise the stored ollama_url is used. Powers the Test/Refresh button and
 * the classification/coaching model dropdowns.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const body = await request.json().catch(() => ({}));
  let url = typeof body.ollama_url === "string" ? body.ollama_url.trim() : "";
  if (!url) {
    url = (await getSystemSettings()).ollama_url?.trim() ?? "";
  }
  if (!url) {
    return NextResponse.json({ error: "Set the Ollama URL first." }, { status: 400 });
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/tags`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      // Don't let a hung Ollama server hang the request forever.
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Ollama responded ${res.status}` },
        { status: 502 }
      );
    }
    const data = (await res.json().catch(() => ({}))) as { models?: { name?: string }[] };
    const models = Array.isArray(data.models)
      ? data.models
          .map((m) => (typeof m?.name === "string" ? m.name : ""))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
      : [];
    return NextResponse.json({ models });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Could not reach the Ollama server";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
