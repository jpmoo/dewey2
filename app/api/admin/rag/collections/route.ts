import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/guard";
import { getSystemSettings } from "@/lib/settings";

/**
 * Fetch the available collections from RAGDoll (GET {url}/rags → { collections }).
 * The URL may be supplied in the body (so the admin can test before saving it);
 * otherwise the stored rag_url is used. Powers the default-collections checkbox
 * list in system settings and the per-user override in the user pane.
 */
export async function POST(request: NextRequest) {
  const guard = await requireAdmin();
  if (guard instanceof NextResponse) return guard;

  const body = await request.json().catch(() => ({}));
  let url = typeof body.rag_url === "string" ? body.rag_url.trim() : "";
  if (!url) url = (await getSystemSettings()).rag_url?.trim() ?? "";
  if (!url) {
    return NextResponse.json({ error: "Set the RAGDoll URL first." }, { status: 400 });
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rags`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `RAGDoll responded ${res.status}` }, { status: 502 });
    }
    const data = (await res.json().catch(() => ({}))) as { collections?: unknown };
    const collections = Array.isArray(data.collections)
      ? data.collections.filter((c): c is string => typeof c === "string").sort((a, b) => a.localeCompare(b))
      : [];
    return NextResponse.json({ collections });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not reach RAGDoll";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
