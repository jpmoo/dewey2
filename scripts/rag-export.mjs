#!/usr/bin/env node
// Export one RAG document's full contents for inspection/diagnosis.
//
// Usage (run from the project root on the server, where .env lives):
//   node scripts/rag-export.mjs            # list documents (id, title, status)
//   node scripts/rag-export.mjs <id>       # dump document <id> to stdout + a file
//
// Writes rag-export-<id>.txt next to where you run it. Read-only; changes nothing.

import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";

// Minimal .env loader so we reuse the app's DATABASE_URL without extra deps.
function loadEnv() {
  if (process.env.DATABASE_URL) return;
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch {
    /* no .env — rely on the ambient environment */
  }
}

function rule(label) {
  return `\n${"=".repeat(78)}\n${label}\n${"=".repeat(78)}\n`;
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (no .env found). Aborting.");
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const id = process.argv[2];
  if (!id) {
    const { rows } = await client.query(
      `SELECT d.id, d.title, d.status, d.mime,
              COALESCE(char_length(d.extracted_text),0) AS chars,
              COUNT(ch.id)::int AS chunks,
              COUNT(ch.id) FILTER (WHERE ch.embedding IS NOT NULL)::int AS embedded
         FROM rag_documents d
         LEFT JOIN rag_chunks ch ON ch.document_id = d.id
        WHERE d.deleted_at IS NULL
        GROUP BY d.id ORDER BY d.id`
    );
    console.log("Documents (pass an id to dump one):\n");
    for (const r of rows) {
      console.log(
        `  #${r.id}  [${r.status}]  ${r.chars.toLocaleString()} chars  ` +
          `${r.embedded}/${r.chunks} embedded  ${r.mime ?? ""}  — ${r.title}`
      );
    }
    await client.end();
    return;
  }

  const dRes = await client.query(
    `SELECT id, title, description, filename, mime, status, status_detail, chunk_total,
            COALESCE(char_length(extracted_text),0) AS chars, extracted_text,
            octet_length(bytes) AS byte_len, created_at, processed_at
       FROM rag_documents WHERE id = $1`,
    [id]
  );
  const d = dRes.rows[0];
  if (!d) {
    console.error(`No document #${id}.`);
    await client.end();
    process.exit(1);
  }
  const cRes = await client.query(
    `SELECT ordinal, source, edited, context, embed_model,
            (embedding IS NOT NULL) AS embedded, text
       FROM rag_chunks WHERE document_id = $1 ORDER BY ordinal`,
    [id]
  );

  const out = [];
  out.push(rule(`DOCUMENT #${d.id}: ${d.title}`));
  out.push(`filename:      ${d.filename ?? "(none)"}`);
  out.push(`mime:          ${d.mime ?? "(none)"}`);
  out.push(`stored bytes:  ${d.byte_len == null ? "(none)" : d.byte_len.toLocaleString()}`);
  out.push(`status:        ${d.status}  — ${d.status_detail ?? ""}`);
  out.push(`extracted:     ${d.chars.toLocaleString()} chars`);
  out.push(`chunk_total:   ${d.chunk_total ?? "(null)"}`);
  out.push(`chunks in db:  ${cRes.rows.length}`);
  out.push(`created:       ${d.created_at?.toISOString?.() ?? d.created_at}`);
  out.push(`processed:     ${d.processed_at?.toISOString?.() ?? d.processed_at ?? "(never)"}`);
  out.push(`description:   ${d.description ?? "(none)"}`);

  out.push(rule("FULL EXTRACTED TEXT (verbatim, as stored)"));
  out.push(d.extracted_text ?? "(empty)");

  out.push(rule(`CHUNKS / SAMPLES (${cRes.rows.length})`));
  for (const r of cRes.rows) {
    out.push(
      `\n----- #${r.ordinal + 1}  source=${r.source}  edited=${r.edited}  ` +
        `embedded=${r.embedded}  model=${r.embed_model ?? "-"}  (${(r.text ?? "").length} chars) -----`
    );
    if (r.context) out.push(`[context] ${r.context}`);
    out.push(r.text ?? "");
  }

  const report = out.join("\n");
  const file = `rag-export-${id}.txt`;
  writeFileSync(file, report, "utf8");
  console.log(report);
  console.error(`\n(Full report written to ${file})`);
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
