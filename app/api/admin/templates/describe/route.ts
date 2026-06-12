import { NextRequest, NextResponse } from "next/server";
import { requireCoachOrAdmin } from "@/lib/guard";
import { summarizeWithComplianceModel } from "@/lib/ai";
import { ACTIVITY_BY_KEY } from "@/lib/activities";
import type { TemplateGraph } from "@/lib/templates";

/**
 * Draft a short template description with the compliance + summarization model.
 * Builds a plain-text outline of the canvas (phases in order, then their
 * activities, then any ungrouped activities) and asks the model to summarize it.
 * Returns { description: "" } on any failure so the save dialog can still open.
 */
export async function POST(request: NextRequest) {
  const guard = await requireCoachOrAdmin();
  if (guard instanceof NextResponse) return guard;

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const g = (body.graph ?? {}) as Partial<TemplateGraph>;
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const phases = Array.isArray(g.phases) ? g.phases : [];

  const labelFor = (key: string, label?: string) =>
    (label && label.trim()) || ACTIVITY_BY_KEY[key]?.label || key;

  const lines: string[] = [];
  if (name) lines.push(`Plan name: ${name}`);

  const phased = new Set<string>();
  for (const phase of phases) {
    const acts = nodes.filter((n) => n.phaseId === phase.id);
    acts.forEach((n) => phased.add(n.id));
    lines.push(`Phase "${phase.name}":`);
    if (acts.length) {
      for (const n of acts) lines.push(`  - ${labelFor(n.activityKey, n.label)}`);
    } else {
      lines.push("  (no activities yet)");
    }
    if (phase.exitConditions?.trim()) {
      lines.push(`  Exit conditions: ${phase.exitConditions.trim()}`);
    }
  }

  const loose = nodes.filter((n) => !phased.has(n.id));
  if (loose.length) {
    lines.push("Ungrouped activities:");
    for (const n of loose) lines.push(`  - ${labelFor(n.activityKey, n.label)}`);
  }

  if (!nodes.length && !phases.length) {
    return NextResponse.json({ description: "" });
  }

  try {
    const description = await summarizeWithComplianceModel(lines.join("\n"));
    return NextResponse.json({ description });
  } catch (e) {
    console.warn("[describe] failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ description: "" });
  }
}
