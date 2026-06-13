import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/guard";
import { getSystemSettings } from "@/lib/settings";

/**
 * Proxy a RAGDoll source document so a signed-in user (coach or partner) can open
 * a source cited by an @dewey message without direct access to the RAGDoll host.
 * `path` is the RAGDoll fetch path, e.g. "/fetch/group/file.pdf".
 */
export async function GET(request: NextRequest) {
  const guard = await requireUser();
  if (guard instanceof NextResponse) return guard;

  const path = request.nextUrl.searchParams.get("path") ?? "";
  if (!path.startsWith("/fetch/")) {
    return NextResponse.json({ error: "Invalid source path" }, { status: 400 });
  }
  // Block path traversal to other endpoints on the RAG host (SSRF). The embedded
  // web-source URL may legitimately contain ":" and "//", but never "..".
  let decodedPath = path;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  const traversal =
    path.includes("..") || decodedPath.includes("..") || /[\\\x00-\x1f]/.test(path);
  if (traversal) {
    return NextResponse.json({ error: "Invalid source path" }, { status: 400 });
  }

  const settings = await getSystemSettings();

  // Some RAG sources are indexed web pages: the fetch path embeds the original
  // URL (e.g. /fetch/group/https%3A/example.com/...). Redirect the user to the
  // real page — but only to an admin-allowlisted host, to prevent open redirects.
  const embedded = path.match(/^\/fetch\/[^/]+\/(https?(?::|%3A).+)$/i);
  if (embedded) {
    let raw = embedded[1];
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* use as-is */
    }
    const u = raw.match(/^(https?):\/{1,2}(.+)$/i);
    if (u) {
      const target = `${u[1].toLowerCase()}://${u[2]}`;
      let host = "";
      try {
        host = new URL(target).hostname.toLowerCase();
      } catch {
        return NextResponse.json({ error: "Invalid source URL" }, { status: 400 });
      }
      const allowed = settings.rag_allowed_source_hosts ?? [];
      const ok = allowed.some((h) => host === h || host.endsWith(`.${h}`));
      if (!ok) {
        return NextResponse.json(
          { error: "This source's host isn't on the allowed list. Ask an admin to add it." },
          { status: 403 }
        );
      }
      return NextResponse.redirect(target);
    }
  }

  const url = settings.rag_url?.trim() ?? "";
  if (!url) return NextResponse.json({ error: "RAGDoll is not configured" }, { status: 400 });

  try {
    const upstream = await fetch(`${url.replace(/\/$/, "")}${path}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: `RAGDoll responded ${upstream.status}` }, { status: 502 });
    }
    const headers = new Headers();
    const ct = upstream.headers.get("content-type");
    const cd = upstream.headers.get("content-disposition");
    if (ct) headers.set("content-type", ct);
    if (cd) headers.set("content-disposition", cd);
    return new Response(upstream.body, { headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not fetch source";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
