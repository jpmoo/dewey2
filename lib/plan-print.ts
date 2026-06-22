/**
 * Builds a self-contained, printable HTML document for a coaching plan, opened in
 * a new window so the user can print or "Save as PDF". Page 1 is the whole arc on
 * one page (phases numbered 1., 2., …; activities lettered a., b., c., …). Page 2+
 * is a detailed outline in the same order, with full phase/activity descriptions.
 */
import type { TemplateGraph } from "@/lib/templates";
import { ACTIVITY_BY_KEY, CATEGORY_META } from "@/lib/activities";
import { nextNodeId } from "@/lib/plan-graph";

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}

/** Spreadsheet-style letters: a..z, aa, ab, … (handles >26 activities in a phase). */
function letter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(97 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Position of each node along the flow (entry → next…), so phases read in order. */
function flowOrder(graph: TemplateGraph): Map<string, number> {
  const order = new Map<string, number>();
  const nodes = graph.nodes ?? [];
  const incoming = new Set((graph.edges ?? []).map((e) => e.target));
  let id: string | null = (nodes.find((n) => !incoming.has(n.id)) ?? nodes[0])?.id ?? null;
  let i = 0;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    order.set(id, i++);
    id = nextNodeId(graph, id);
  }
  // Any nodes not reachable from the entry walk fall back to array order.
  for (const n of nodes) if (!order.has(n.id)) order.set(n.id, i++);
  return order;
}

interface PrintActivity {
  label: string;
  category: string;
  gating: string;
  description: string;
  artifact: string;
}
interface PrintPhase {
  name: string;
  exitConditions: string;
  activities: PrintActivity[];
}

function gatingLabel(g?: string): string {
  return g === "OPEN" ? "Partner Attests" : "Coach Approves";
}

function structurePlan(graph: TemplateGraph): { phases: PrintPhase[] } {
  const order = flowOrder(graph);
  const nodes = (graph.nodes ?? []).slice().sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
  );

  const toActivity = (n: TemplateGraph["nodes"][number]): PrintActivity => {
    const def = ACTIVITY_BY_KEY[n.activityKey];
    return {
      label: n.label || def?.label || "Activity",
      category: CATEGORY_META[def?.category as keyof typeof CATEGORY_META]?.label || "",
      gating: gatingLabel(n.gating ?? def?.defaultGating),
      description: n.instructions || def?.defaultInstructions || "",
      artifact: n.artifact || def?.defaultArtifact || "",
    };
  };

  const phases: PrintPhase[] = (graph.phases ?? []).map((p) => ({
    name: p.name || "Phase",
    exitConditions: p.exitConditions || "",
    activities: nodes.filter((n) => n.phaseId === p.id).map(toActivity),
  }));

  // Activities not assigned to any phase get a trailing catch-all section.
  const phaseIds = new Set((graph.phases ?? []).map((p) => p.id));
  const ungrouped = nodes.filter((n) => !n.phaseId || !phaseIds.has(n.phaseId));
  if (ungrouped.length) {
    phases.push({ name: "Other Activities", exitConditions: "", activities: ungrouped.map(toActivity) });
  }
  return { phases };
}

export function buildPlanPrintHtml(name: string, graph: TemplateGraph): string {
  const { phases } = structurePlan(graph);
  const title = esc(name || "Coaching Plan");

  // Page 1 — the arc at a glance.
  const arc = phases
    .map((p, pi) => {
      const acts = p.activities
        .map((a, ai) => `<li><span class="anum">${letter(ai)}.</span> ${esc(a.label)}</li>`)
        .join("");
      return `<li class="phase">
        <div class="pname"><span class="pnum">${pi + 1}.</span> ${esc(p.name)}</div>
        <ol class="acts">${acts || '<li class="empty">No activities yet</li>'}</ol>
      </li>`;
    })
    .join("");

  // Page 2+ — detailed outline.
  const detail = phases
    .map((p, pi) => {
      const acts = p.activities
        .map((a, ai) => {
          const meta = [a.category, a.gating].filter(Boolean).map(esc).join(" &middot; ");
          return `<div class="dact">
            <h3><span class="anum">${letter(ai)}.</span> ${esc(a.label)}</h3>
            ${meta ? `<p class="meta">${meta}</p>` : ""}
            ${a.description ? `<p>${esc(a.description)}</p>` : ""}
            ${a.artifact ? `<p class="artifact"><strong>Artifact:</strong> ${esc(a.artifact)}</p>` : ""}
          </div>`;
        })
        .join("");
      return `<section class="dphase">
        <h2><span class="pnum">${pi + 1}.</span> ${esc(p.name)}</h2>
        ${p.exitConditions ? `<p class="exit"><strong>Exit conditions:</strong> ${esc(p.exitConditions)}</p>` : ""}
        ${acts || '<p class="empty">No activities yet.</p>'}
      </section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<title>${title}</title>
<style>
  @page { size: letter; margin: 0.6in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #1a1a1a; margin: 0; line-height: 1.4; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  .sub { color: #666; font-size: 12px; margin: 0 0 18px; text-transform: uppercase; letter-spacing: .06em; }
  .pnum, .anum { font-weight: 700; }
  /* Page 1 — arc overview */
  .arc .phases { list-style: none; padding: 0; margin: 0; column-width: 240px; column-gap: 28px; }
  .arc .phase { break-inside: avoid; -webkit-column-break-inside: avoid; margin: 0 0 14px; }
  .arc .pname { font-size: 14px; font-weight: 600; border-bottom: 1px solid #ddd; padding-bottom: 3px; margin-bottom: 5px; }
  .arc .acts { list-style: none; padding: 0 0 0 14px; margin: 0; }
  .arc .acts li { font-size: 12.5px; margin: 2px 0; }
  .arc .anum { color: #555; }
  .empty { color: #999; font-style: italic; }
  /* Page 2+ — detailed outline */
  .detail { page-break-before: always; }
  .detail > h1 { margin-bottom: 16px; }
  .dphase { margin: 0 0 18px; }
  .dphase h2 { font-size: 16px; margin: 0 0 4px; padding-bottom: 3px; border-bottom: 2px solid #1a1a1a; }
  .exit { font-size: 12px; color: #444; background: #f5f5f5; padding: 6px 8px; border-radius: 4px; margin: 6px 0 10px; }
  .dact { break-inside: avoid; -webkit-column-break-inside: avoid; margin: 0 0 12px; padding-left: 12px; border-left: 3px solid #ccc; }
  .dact h3 { font-size: 13.5px; margin: 0 0 2px; }
  .dact .meta { font-size: 11px; color: #777; margin: 0 0 4px; text-transform: uppercase; letter-spacing: .04em; }
  .dact p { font-size: 12.5px; margin: 3px 0; }
  .artifact { color: #333; }
  @media screen { body { max-width: 8.5in; margin: 0 auto; padding: 0.6in; } }
</style></head>
<body>
  <section class="arc">
    <h1>${title}</h1>
    <p class="sub">Coaching Arc</p>
    <ol class="phases">${arc || '<li class="empty">This plan has no phases yet.</li>'}</ol>
  </section>
  <section class="detail">
    <h1>${title}</h1>
    <p class="sub">Detailed Outline</p>
    ${detail}
  </section>
  <script>
    window.addEventListener("load", function () {
      setTimeout(function () { window.focus(); window.print(); }, 200);
    });
    window.addEventListener("afterprint", function () { window.close(); });
  </script>
</body></html>`;
}
