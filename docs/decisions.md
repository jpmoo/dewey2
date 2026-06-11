# Dewey 2.0 — Locked Product Decisions

This document records decisions that have been explicitly made and should not be revisited without a deliberate conversation. When Claude Code proposes something that conflicts with an item here, flag it rather than proceeding.

---

## Architecture

### The AI is a companion, not the primary coach
Human coaches are the primary relationship. The AI supports them — within activities that call for it, and in phase exit analysis. The AI does not drive the coaching experience.

### Arc → Phase → Activity is the canonical object model
This hierarchy is fixed. Arcs contain phases in order; phases contain activities in order.

- **Activities** have done states
- **Phases** have exit conditions (distinct from done states — this distinction matters)

Do not flatten or conflate these levels.

### Phase exit is coach-gated, always
When a partner completes the final activity in a phase, the AI evaluates artifacts against exit conditions and surfaces analysis to the coach. The coach approves advancement or reopens activities. This is not configurable per-phase — it is how phases work.

### The AI never surfaces a readiness verdict to the partner
Phase advancement readiness is communicated coach → partner, not AI → partner.

---

## Activity Design

### Four categories, no more
The activity taxonomy has exactly four categories:
1. Reflecting & Solving (AI-involved, conversational)
2. Input & Inquiry (partner self-attests)
3. Observation & Being Observed (coach-determined, no AI)
4. Implementation (coach-determined)

Category determines who/what decides completion and whether AI is available. New activity types should fit one of these four; do not add categories.

### No composite activity types
PDSA cycles, equity audits, and similar multi-step structures are correctly modeled as template phases or arcs, not as activity types. If something feels like it needs sub-steps, it belongs at a higher level of the hierarchy.

### Artifacts are outputs, not activities
Artifact creation is not a standalone activity type. Artifacts emerge naturally from other activities (especially Reflecting & Solving and Input & Inquiry). The system tracks what artifacts an activity produces; it does not have an "artifact creation" activity.

### Commitments are byproducts
Commitments arise from goal-setting within impact cycles. They are not modeled as independent activity types.

### The same activity types recur across phases
This is intentional. A "Describe Current Reality" activity in Phase 1 and Phase 3 of an Impact Cycle are the same activity type with different context. Do not create phase-specific variants of activity types.

---

## Plan Builder

### Canvas-based, drag-and-connect
Coaches build plans on a canvas. Activities are dragged in and connected into phases; phases are connected into arcs. This is the interaction model — not a form-based or list-based builder.

### Templates are system-provided starting points
The system ships with templates (Impact Cycle, Problem of Practice, book study). Coaches can use them as-is, customize them, or build from scratch. Templates live at the arc level.

---

## Gating

### Two and only two gating modes
- **OPEN** — partner self-attests (clicks "Mark Complete")
- **REVIEWED** — coach approves via message center thread

These are the only gating modes. Do not add intermediate states.

---

## Retained from 1.0

### Two-model stack is preserved
Ollama handles routing and compliance. Claude API handles reasoning and coaching. This is not changing.

### JSON contract pattern is preserved
AI responses for coaching and phase evaluation return structured JSON with reasoning fields. This auditability is intentional.

### RAG integration is preserved
Document retrieval via RAGDoll (semantic similarity) continues to ground AI responses in organizational context.

### Compliance screen is preserved
Ollama-based pre-generation safety check is retained.
