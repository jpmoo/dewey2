/**
 * Minimal, dependency-free sanitizer for the lightweight document editor. The
 * editor only emits a small allowlisted subset (bold/italic/underline, font
 * size, paragraphs, lists, headings); we strip everything else and re-sanitize
 * on render so a crafted payload can't inject script/handlers into the chat.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "b", "strong", "i", "em", "u", "s",
  "ul", "ol", "li", "span", "div", "h1", "h2", "h3", "blockquote", "font",
]);
// style declarations we keep (purely cosmetic, no urls/expressions).
const ALLOWED_STYLE = new Set(["font-size", "font-weight", "font-style", "text-decoration", "text-align"]);

function safeStyle(raw: string): string {
  const out: string[] = [];
  for (const decl of raw.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLE.has(prop)) continue;
    // Reject anything that could smuggle a url/expression.
    if (/url\(|expression|javascript:|@import|[<>]/i.test(val)) continue;
    if (val.length > 40) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join("; ");
}

export function sanitizeDocumentHtml(input: string): string {
  if (!input) return "";
  let html = input;
  // Drop dangerous elements WITH their content, and all comments.
  html = html.replace(/<(script|style|iframe|object|embed|svg|math)[\s\S]*?<\/\1>/gi, "");
  html = html.replace(/<(script|style|iframe|object|embed|svg|math)[^>]*>/gi, "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // Rewrite every remaining tag: keep allowlisted ones with a filtered style
  // attribute only; drop the rest (their text content stays).
  return html.replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)([^>]*)>/g, (_m, slash: string, name: string, attrs: string) => {
    const tag = name.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (slash) return `</${tag}>`;
    if (tag === "br") return "<br>";
    // <font size="1..7"> from execCommand('fontSize') — keep only a numeric size.
    if (tag === "font") {
      const sizeM = attrs.match(/\bsize\s*=\s*"?([1-7])"?/i);
      return sizeM ? `<font size="${sizeM[1]}">` : "<font>";
    }
    const styleMatch = attrs.match(/\bstyle\s*=\s*"([^"]*)"/i) || attrs.match(/\bstyle\s*=\s*'([^']*)'/i);
    const style = styleMatch ? safeStyle(styleMatch[1]) : "";
    return style ? `<${tag} style="${style}">` : `<${tag}>`;
  });
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
};

/** Strip a document's HTML down to readable plain text (for the AI / search). */
export function htmlToPlainText(input: string): string {
  if (!input) return "";
  let s = input;
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  // Block-level boundaries become newlines.
  s = s.replace(/<\/(p|div|li|h1|h2|h3|blockquote|ul|ol|tr)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&#?\w+;/g, (m) => ENTITIES[m.toLowerCase()] ?? m);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
