import { htmlToPlainText } from "@/lib/html-sanitize";

/**
 * Extract readable text from an uploaded attachment so the AI can see its
 * contents. Supports PDF (pdf-parse), Word .docx (mammoth), and text-like files;
 * returns null for anything else (e.g. images). Node runtime only.
 */

// Default cap suits a message attachment (the AI only needs a peek). RAG ingest
// passes maxChars: 0 to get the full document — truncating there would silently
// drop half a multi-page document from retrieval.
const MAX_CHARS = 12000;

export interface ExtractOptions {
  /** Max characters to keep; 0 (or negative) means no limit. Defaults to 12000. */
  maxChars?: number;
}

function clip(s: string, maxChars: number): string | null {
  const t = s.trim();
  if (!t) return null;
  if (maxChars <= 0 || t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n…[truncated]`;
}

export async function extractText(
  filename: string,
  mimeType: string,
  buf: Buffer,
  opts: ExtractOptions = {}
): Promise<string | null> {
  const max = opts.maxChars ?? MAX_CHARS;
  const name = (filename || "").toLowerCase();
  const mime = (mimeType || "").toLowerCase();
  try {
    if (mime === "application/pdf" || name.endsWith(".pdf")) {
      const mod = await import("pdf-parse");
      const PDFParse = (mod as { PDFParse?: typeof import("pdf-parse").PDFParse }).PDFParse
        ?? (mod as { default?: { PDFParse: typeof import("pdf-parse").PDFParse } }).default?.PDFParse;
      if (!PDFParse) return null;
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const res = await parser.getText();
        return clip(res.text || "", max);
      } finally {
        await parser.destroy().catch(() => {});
      }
    }
    if (
      name.endsWith(".docx") ||
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const mod = await import("mammoth");
      const mammoth = (mod as { extractRawText?: typeof import("mammoth").extractRawText }).extractRawText
        ? (mod as typeof import("mammoth"))
        : ((mod as { default: typeof import("mammoth") }).default);
      const res = await mammoth.extractRawText({ buffer: buf });
      return clip(res.value || "", max);
    }
    if (mime === "text/html" || name.endsWith(".html") || name.endsWith(".htm")) {
      return clip(htmlToPlainText(buf.toString("utf8")), max);
    }
    if (
      mime.startsWith("text/") ||
      /\.(txt|md|markdown|csv|tsv|json|log)$/.test(name)
    ) {
      return clip(buf.toString("utf8"), max);
    }
  } catch (e) {
    console.warn("[extract] failed for", filename, e instanceof Error ? e.message : e);
  }
  return null;
}
