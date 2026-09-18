import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { extractText } from "@/lib/extract";
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
const RASTER_DPI = "150";

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

async function describe(png: string, model: string, ollamaUrl: string): Promise<string> {
  try {
    const b64 = (await fs.readFile(png)).toString("base64");
    const res = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: VISION_PROMPT, images: [b64], stream: false }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return "";
    const data = (await res.json().catch(() => ({}))) as { response?: string };
    const out = (data.response ?? "").trim();
    return out && out.toUpperCase() !== "NONE" ? out : "";
  } catch {
    return "";
  }
}

function sanitize(name: string): string {
  return (name || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
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

  // 1. Native text layer. maxChars: 0 = keep the whole document (the default cap
  // is for message-attachment peeks and would drop half a multi-page doc). A
  // malformed file can make the parser throw; treat that as "no native text" so
  // the OCR/vision stages still get a chance.
  const native = (
    (await extractText(filename, mime, bytes, { maxChars: 0 }).catch(() => null)) ?? ""
  ).trim();
  if (native) {
    parts.push(native);
    methods.add("text");
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dewey-rag-${randomUUID()}-`));
  let pdfBytes: Buffer | null = null;
  try {
    pdfBytes = await toPdf(dir, filename, mime, bytes);
    if (pdfBytes && !isPdf(filename, mime)) methods.add("pdf");

    // Only rasterize if we'll actually use the pages (scanned doc or vision on).
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
          if (d) {
            parts.push(`[Figure/chart] ${d}`);
            methods.add("vision");
          }
        }
      }
    }
  } catch (e) {
    console.warn("[rag-extract] pipeline error:", e instanceof Error ? e.message : e);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return { text: parts.join("\n\n").trim(), pdfBytes, methods: Array.from(methods) };
}
