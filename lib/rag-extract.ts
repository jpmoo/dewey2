import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { extractText } from "@/lib/extract";
import { htmlToPlainText } from "@/lib/html-sanitize";
import { getSystemSettings } from "@/lib/settings";

/**
 * Document → text pipeline for RAG ingest. Layered and best-effort: each stage
 * runs only if its tool is installed, so the app degrades gracefully.
 *   1. native text layer (pdf-parse / mammoth / plain — lib/extract)
 *   2. normalize to PDF (LibreOffice for office docs; images via img2pdf/convert)
 *   3. rasterize pages (poppler pdftoppm) → OCR (Tesseract) for scanned pages
 *   4. vision model (Ollama) describes charts/figures per page
 * Returns the combined text plus a normalized PDF (when produced) for storage.
 */

const exec = promisify(execFile);
const MAX_PAGES = 40; // cap raster/OCR/vision work per document
const RASTER_DPI = "200"; // higher DPI helps the vision model read dense tables

const whichCache = new Map<string, boolean>();
async function has(cmd: string): Promise<boolean> {
  const cached = whichCache.get(cmd);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    await exec("which", [cmd]);
    ok = true;
  } catch {
    ok = false;
  }
  whichCache.set(cmd, ok);
  return ok;
}

export interface ExtractResult {
  text: string;
  /** Normalized PDF bytes (when we could produce one), for storage/serving. */
  pdfBytes: Buffer | null;
  /** Which stages contributed (for logging/status). */
  methods: string[];
  /** Non-fatal problems worth surfacing (e.g. the vision model failing to load). */
  warnings: string[];
}

function isPdf(filename: string, mime: string): boolean {
  return mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
}
function isImage(filename: string, mime: string): boolean {
  return mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(filename);
}
function isOffice(filename: string, mime: string): boolean {
  return (
    /\.(docx?|pptx?|xlsx?|odt|odp|ods|rtf)$/i.test(filename) ||
    mime.includes("officedocument") ||
    mime.includes("msword") ||
    mime.includes("ms-powerpoint") ||
    mime.includes("ms-excel") ||
    mime.includes("opendocument")
  );
}

/** Best-effort conversion of the input to a PDF Buffer, or null. */
async function toPdf(dir: string, filename: string, mime: string, bytes: Buffer): Promise<Buffer | null> {
  if (isPdf(filename, mime)) return bytes;
  const inPath = path.join(dir, `in-${sanitize(filename) || "file"}`);
  await fs.writeFile(inPath, bytes);

  if (isImage(filename, mime)) {
    const out = path.join(dir, "img.pdf");
    if (await has("img2pdf")) {
      try {
        await exec("img2pdf", [inPath, "-o", out]);
        return await fs.readFile(out);
      } catch {
        /* fall through */
      }
    }
    if (await has("convert")) {
      try {
        await exec("convert", [inPath, out]);
        return await fs.readFile(out);
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  if (isOffice(filename, mime) && (await has("soffice"))) {
    try {
      await exec("soffice", ["--headless", "--convert-to", "pdf", "--outdir", dir, inPath], {
        timeout: 120000,
      });
      const base = path.basename(inPath).replace(/\.[^.]+$/, "");
      return await fs.readFile(path.join(dir, `${base}.pdf`));
    } catch {
      return null;
    }
  }
  return null;
}

async function rasterize(dir: string, pdfPath: string): Promise<string[]> {
  if (!(await has("pdftoppm"))) return [];
  try {
    await exec(
      "pdftoppm",
      ["-png", "-r", RASTER_DPI, "-l", String(MAX_PAGES), pdfPath, path.join(dir, "pg")],
      { timeout: 180000 }
    );
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith("pg-") && f.endsWith(".png"));
    files.sort();
    return files.map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

async function ocr(png: string): Promise<string> {
  if (!(await has("tesseract"))) return "";
  try {
    const { stdout } = await exec("tesseract", [png, "stdout"], { maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Extract a PDF's text layer with poppler's pdftotext. This is far more reliable
 * than pdf-parse on designed/exported PDFs (which often defeat pdf-parse and force
 * a bad OCR fallback), so it's the primary text source for PDFs when available.
 */
async function pdfToText(dir: string, pdfBytes: Buffer): Promise<string> {
  if (!(await has("pdftotext"))) return "";
  try {
    const p = path.join(dir, "text-src.pdf");
    await fs.writeFile(p, pdfBytes);
    const { stdout } = await exec("pdftotext", ["-nopgbrk", p, "-"], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120000,
    });
    return stdout.trim();
  } catch (e) {
    console.warn("[rag-extract] pdftotext failed:", e instanceof Error ? e.message : e);
    return "";
  }
}

const VISION_PROMPT =
  "You are extracting page content for search and retrieval. Look only at charts, graphs, " +
  "figures, tables, and diagrams on this page (ignore ordinary body paragraphs — those are " +
  "captured separately).\n" +
  "For each such visual:\n" +
  "- Begin with one short sentence naming what it is and its subject (e.g. \"A table describing " +
  "the continual-improvement process.\").\n" +
  "- Then transcribe its content faithfully and completely: every label, category, term, and " +
  "number, and the relationships between them. Do not summarize or omit specifics.\n" +
  "- Reconstruct any TABLE as a Markdown table (with the real header row and every data cell) so " +
  "row/column relationships are preserved. Reconstruct a process/flow diagram as an ordered list " +
  "of its steps with the exact labels.\n" +
  "If the page has no chart, table, figure, or diagram, reply with just: NONE.";

/** Result of one vision call: description text (may be empty) plus an error note. */
async function describe(
  png: string,
  model: string,
  ollamaUrl: string
): Promise<{ text: string; error?: string }> {
  try {
    const b64 = (await fs.readFile(png)).toString("base64");
    const res = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // keep_alive holds the (large) vision model in memory across pages; a big
      // model's first load plus per-page inference can be slow, so allow more time.
      body: JSON.stringify({
        model,
        prompt: VISION_PROMPT,
        images: [b64],
        stream: false,
        keep_alive: "30m",
      }),
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      console.warn("[rag-extract] vision", res.status, body);
      // Extract the meaningful bit of an Ollama error for the status line.
      let msg = `vision model error (${res.status})`;
      try {
        const j = JSON.parse(body) as { error?: string };
        if (j.error) msg = j.error.split("\n")[0].slice(0, 160);
      } catch {
        /* keep generic */
      }
      return { text: "", error: msg };
    }
    const data = (await res.json().catch(() => ({}))) as { response?: string };
    const out = (data.response ?? "").trim();
    // Treat "NONE", "None.", "none" etc. as no-visual (models add punctuation/case).
    const normalized = out.replace(/[\s.]+$/, "").toUpperCase();
    return { text: out && normalized !== "NONE" ? out : "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[rag-extract] vision error:", msg);
    return { text: "", error: msg.slice(0, 160) };
  }
}

function sanitize(name: string): string {
  return (name || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

/** Reject non-http(s) URLs and obvious internal/loopback hosts (basic SSRF guard). */
export function isSafePublicUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  // Block IP-literal hosts in private/loopback/link-local ranges.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
  }
  if (host === "::1" || host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) {
    return false;
  }
  return true;
}

/**
 * Fetch a web page (or a linked PDF) and return its readable text. Best-effort
 * and safe: only public http(s) URLs, capped size, short timeout.
 */
export async function fetchUrlText(url: string): Promise<{ text: string; title: string | null }> {
  if (!isSafePublicUrl(url)) throw new Error("That URL isn't allowed.");
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "DeweyBot/1.0 (+document ingest)", accept: "text/html,application/pdf,*/*" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`The page responded ${res.status}.`);
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error("That page is too large to ingest.");

  // A linked PDF goes through the normal document pipeline.
  if (ctype.includes("application/pdf") || url.toLowerCase().endsWith(".pdf")) {
    const ex = await extractDocument(url.split("/").pop() || "page.pdf", "application/pdf", buf);
    return { text: ex.text, title: null };
  }

  const html = buf.toString("utf8");
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 200) : null;
  const text = htmlToPlainText(html);
  return { text, title: title || null };
}

export async function extractDocument(
  filename: string,
  mime: string,
  bytes: Buffer
): Promise<ExtractResult> {
  const settings = await getSystemSettings();
  const ollamaUrl = (settings.ollama_url ?? "").trim();
  const visionModel = (settings.ollama_vision_model ?? "").trim();
  const useVision = !!ollamaUrl && !!visionModel;

  const parts: string[] = [];
  const methods = new Set<string>();
  const warnings = new Set<string>();

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dewey-rag-${randomUUID()}-`));
  let pdfBytes: Buffer | null = null;
  let native = "";
  let visionErr = "";
  try {
    pdfBytes = await toPdf(dir, filename, mime, bytes);
    if (pdfBytes && !isPdf(filename, mime)) methods.add("pdf");

    // 1. Native text layer. For PDFs, prefer poppler's pdftotext — pdf-parse
    // silently returns nothing on many designed/exported PDFs, which used to
    // force a garbage OCR fallback. maxChars: 0 keeps the whole document (the
    // extractText cap is only for message-attachment peeks).
    if (pdfBytes) {
      native = await pdfToText(dir, pdfBytes);
      if (native) methods.add("pdftotext");
    }
    if (!native) {
      native = (
        (await extractText(filename, mime, bytes, { maxChars: 0 }).catch(() => null)) ?? ""
      ).trim();
      if (native) methods.add("text");
    }
    if (native) parts.push(native);

    // Rasterize for OCR (only when there's no usable text layer) and/or vision.
    const scanned = native.length < 200;
    if (pdfBytes && (scanned || useVision)) {
      const pdfPath = path.join(dir, "doc.pdf");
      await fs.writeFile(pdfPath, pdfBytes);
      const pages = await rasterize(dir, pdfPath);
      for (const pg of pages) {
        if (scanned) {
          const t = await ocr(pg);
          if (t) {
            parts.push(t);
            methods.add("ocr");
          }
        }
        if (useVision) {
          const d = await describe(pg, visionModel, ollamaUrl);
          if (d.text) {
            parts.push(`[Figure/chart] ${d.text}`);
            methods.add("vision");
          }
          if (d.error) visionErr = d.error;
        }
      }
      // Surface a vision failure once, but only if it never succeeded on any page.
      if (useVision && visionErr && !methods.has("vision")) {
        warnings.add(`Vision model "${visionModel}" failed — figures not described (${visionErr}).`);
      }
    }
  } catch (e) {
    console.warn("[rag-extract] pipeline error:", e instanceof Error ? e.message : e);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    text: parts.join("\n\n").trim(),
    pdfBytes,
    methods: Array.from(methods),
    warnings: Array.from(warnings),
  };
}
