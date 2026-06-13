import { getPool } from "@/lib/pg";
import { chatComplete } from "@/lib/ai";
import { queryRagDefault, formatRagContext } from "@/lib/rag";
import { ACTIVITY_BY_KEY } from "@/lib/activities";
import {
  addConsultTurn,
  ensureSchema,
  getPhaseApprovedSubmissions,
  getSubmission,
  getTemplate,
  type ActivitySubmission,
} from "@/lib/db";
import { isLastInPhase } from "@/lib/plan-graph";
import type { TemplateGraph } from "@/lib/templates";

/**
 * Dewey's coach-facing review consult. Given a submission, Dewey advises the
 * COACH on whether the partner's submission achieves the activity's goal (and,
 * when it's the last activity in the phase, whether the combined phase
 * submissions meet the phase's exit conditions). Dewey never decides and never
 * addresses the partner — the coach is always the decision-maker (see CLAUDE.md).
 * Each consult turn (coach question + Dewey reply) is persisted.
 */

async function messageContent(
  messageId: number | null
): Promise<{ body: string; attachments: string[] } | null> {
  if (messageId == null) return null;
  const pool = getPool();
  const m = await pool.query("SELECT body FROM messages WHERE id = $1 AND deleted_at IS NULL", [
    messageId,
  ]);
  if (!m.rows[0]) return null;
  const a = await pool.query(
    "SELECT filename, extracted_text FROM message_attachments WHERE message_id = $1 ORDER BY id",
    [messageId]
  );
  // Include the parsed contents so the consult assesses the actual document, not
  // just its filename.
  const attachments = a.rows.map((r) =>
    r.extracted_text
      ? `${r.filename}:\n"""${r.extracted_text}"""`
      : (r.filename as string)
  );
  return { body: m.rows[0].body as string, attachments };
}

function describeActivity(graph: TemplateGraph, nodeId: string): string {
  const node = (graph.nodes ?? []).find((n) => n.id === nodeId);
  if (!node) return "(activity not found)";
  const label = node.label || ACTIVITY_BY_KEY[node.activityKey]?.label || node.activityKey;
  const parts = [`Activity: ${label}`];
  if (node.instructions) parts.push(`What the partner was asked to do: ${node.instructions}`);
  if (node.artifact) parts.push(`Expected output (artifact): ${node.artifact}`);
  return parts.join("\n");
}

export async function consultDeweyOnSubmission(params: {
  submissionId: number;
  question: string;
}): Promise<string | null> {
  await ensureSchema();
  const sub = await getSubmission(params.submissionId);
  if (!sub) return null;
  const plan = await getTemplate(sub.plan_id);
  if (!plan) return null;
  const graph = plan.graph;
  const lastInPhase = isLastInPhase(graph, sub.node_id);

  const submissionMsg = await messageContent(sub.message_id);
  const phase = (graph.phases ?? []).find((p) => p.id === sub.phase_id);

  // Prior approved submissions in this phase (excluding the current activity).
  const prior = (await getPhaseApprovedSubmissions(sub.plan_id, sub.phase_id)).filter(
    (s: ActivitySubmission) => s.node_id !== sub.node_id
  );
  const priorBlocks: string[] = [];
  for (const s of prior) {
    const content = await messageContent(s.message_id);
    if (!content) continue;
    const node = (graph.nodes ?? []).find((n) => n.id === s.node_id);
    const label = node?.label || node?.activityKey || s.node_id;
    priorBlocks.push(
      `- [${label}] ${content.body}${
        content.attachments.length ? ` (attachments: ${content.attachments.join(", ")})` : ""
      }`
    );
  }

  // Ground the advice in the organization's strategic plans/goals via RAGDoll.
  // Retrieve against the activity goal + the partner's submission + the coach's
  // question so the right strategic documents surface.
  const node = (graph.nodes ?? []).find((n) => n.id === sub.node_id);
  const ragQuery = [
    node?.label || node?.activityKey,
    node?.instructions,
    node?.artifact,
    submissionMsg?.body,
    params.question,
  ]
    .filter(Boolean)
    .join("\n");
  const chunks = await queryRagDefault(ragQuery).catch(() => []);

  let system = `You are @dewey, an AI coaching companion on Dewey, advising a human COACH as they review a partner's work. You are speaking ONLY to the coach — never to the partner — and you do NOT make the decision. Give the coach a clear, honest, concise assessment of whether the submission meets the activity's goal, what's strong, and what (if anything) is missing. Weigh the work against the organization's strategic plans, goals, and priorities (excerpts below when available) and reference the specific source so the coach can connect the partner's work to those goals. The coach decides whether to approve or return it.`;
  if (chunks.length > 0) {
    system +=
      "\n\nRelevant excerpts from the organization's documents (strategic plans, goals, priorities, frameworks, etc.) — ground your assessment in these and name the source:\n" +
      formatRagContext(chunks);
  }

  const contextParts = [
    `Coaching plan: ${plan.name}`,
    describeActivity(graph, sub.node_id),
  ];
  if (submissionMsg) {
    contextParts.push(
      `\nThe partner's submission:\n"""${submissionMsg.body}"""${
        submissionMsg.attachments.length
          ? `\n(attachments: ${submissionMsg.attachments.join(", ")})`
          : ""
      }`
    );
  } else {
    contextParts.push("\nThe partner's submission message is unavailable.");
  }
  if (lastInPhase) {
    contextParts.push(
      `\nThis is the LAST activity in the phase "${phase?.name ?? ""}". Phase exit conditions:\n${
        phase?.exitConditions || "(none specified)"
      }`
    );
    if (priorBlocks.length) {
      contextParts.push(
        `\nApproved submissions from earlier activities in this phase:\n${priorBlocks.join("\n")}`
      );
      contextParts.push(
        "\nConsider whether the submissions TOGETHER satisfy the phase's exit conditions."
      );
    }
  }
  contextParts.push(`\nThe coach asks:\n${params.question}`);

  const result = await chatComplete({
    system,
    messages: [{ role: "user", content: contextParts.join("\n") }],
    maxTokens: 1500,
  });
  const reply = result.text.trim();

  await addConsultTurn(params.submissionId, "coach", params.question);
  await addConsultTurn(params.submissionId, "dewey", reply);
  return reply;
}
