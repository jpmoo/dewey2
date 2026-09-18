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

### RAG integration is preserved (retrieval grounding), but moves in-house
Semantic-similarity retrieval still grounds AI responses in organizational
context. RAGDoll (a generic external proof-of-concept) is being **replaced** by a
native, in-house RAG subsystem — see "In-house RAG (document sources)" below.

### Compliance screen is preserved
Ollama-based pre-generation safety check is retained.

---

## In-house RAG (document sources)

Replaces RAGDoll with a native subsystem so ingestion, querying, serving, and
review all live inside Dewey.

### Stack: Ollama embeddings + Postgres/pgvector
Local Ollama embedding model (e.g. `nomic-embed-text`); embeddings stored in a
`vector` column via the pgvector extension (both already on the server). Cosine
similarity search in Postgres. No external service; nothing leaves the box. The
embedding model/dimension is a one-time commitment — changing it means
re-embedding the corpus.

### Documents live in a hierarchy of stores; retrieval inherits upward
Every document is stamped with a **level + unit**:
`system` (root) → `district` → `school` → `cop` (a Community of Practice, bottom).
Retrieval for an activity resolves the **ancestor chain** and unions it:
- a regular partnership pulls `system ∪ district ∪ school` (the **coachee's** units);
- a CoP pulls `system ∪ district ∪ school ∪ that CoP's own store`.

A CoP anchors to a **school** (inherits school+district+system) or a **district**
(inherits district+system). Inheritance is a query-time union — no duplication.

### Four categories, global and standard (not per-unit free-text)
A single admin-managed vocabulary, so plan/node source config stays portable
across districts/schools and inheritance merges cleanly. **Category and level are
independent axes** — a document has one level+unit and one or more categories.

1. **Frameworks, Models & Plans** — coaching/leadership/instructional frameworks
   (Impact Cycle, PoP, competency frameworks) *and* the unit's strategic/
   improvement plans, mission/vision, goal structures.
2. **Research, Evidence & Readings** — the evidence base plus assigned articles
   and book-study texts.
3. **Protocols & Tools** — procedures and instruments: facilitation/observation/
   interview protocols, rubrics, surveys, look-fors, data-collection sheets.
4. **Local Context** — the unit's performance/demographic **data**, **exemplars**
   of strong practice, and the **standards & policy** it's held to.

System admin can add more categories later.

### Ingestion is system-admin-first
System admin uploads and, at ingest, picks the **level + unit** (which district /
school / CoP) and one or more **categories**. Text extraction reuses `lib/extract`
(pdf-parse + mammoth); documents are chunked and embedded. Per-level admins (and
CoP chairs into their own store) come later.

### Source selection: node-level + arc-level "standing" sources
A **source selector** is `{ categories: [...] | "all", documentIds: [...] }` — it
can name buckets *and/or* specific documents. It attaches at two levels:
- **Per node** — the sources for that activity.
- **Per arc ("standing sources")** — ongoing resources unioned into *every*
  activity's retrieval for the whole arc (e.g. pin the strategic plan).

Query = embed the prompt, cosine top-k (~8, with a similarity floor) over
`node.sources ∪ arc.standingSources`, clipped to the visible org chain. **Default
is "all"** — an empty node selector draws from every category in the chain.

### Downstream shape is preserved
The `RagChunk`/source-link shape and the three call sites (@dewey chat, coach
review consult, canvas assistant) are unchanged apart from passing bucket/doc
scope; source-link pills keep working. Documents are served from the in-house
store (admins browse/preview/delete by level/unit/category).

---

## Communities of Practice (CoP)

A conversation with more than two participants can be designated a **Community of
Practice**. Distinct from a regular 2-person partnership.

### One community arc, tied to a goal
A CoP has a **single arc** for the whole community, anchored to a stated
problem/goal. Individuals in a CoP do **not** carry their own arcs (individual
arcs remain the thing for 2-person partnerships). The goal/problem is stored on
the CoP and **injected as AI context** throughout that arc.

### The Chair, not a coach, owns the arc
Each CoP has a **Chair** — a **per-CoP designation** (any member can hold it; it
is *not* a global system role). The Chair builds/assigns the arc via the canvas
(scoped to that CoP), reviews contributions, and decides when the community is
ready to advance. **School and district admins can also edit/set** the arc. The
Chair **fully replaces** the coach requirement — a CoP needs no coach.

### Collective progression, multiple contributions
The community moves through the arc **together** (one shared current activity).
**Multiple members contribute** to an activity; the Chair reviews all
contributions and decides whether the group is ready for the next step. OPEN
activities self-attest; REVIEWED activities surface to the Chair.

### Private @dewey with share-to-group
Inside a CoP, a member's `@dewey` exchange is **private to that member by default**
(reusing the `messages.audience` restricted-visibility mechanism), clearly marked
private, with a **"Share with group"** action that widens visibility to the whole
community.

### CoP anchoring for RAG
A CoP has its own document store at the bottom of the RAG hierarchy (see In-house
RAG), inheriting school/district/system per its anchor.

---

## Terminology (collegial framing)

The workflow language is deliberately collegial rather than gatekeeping:
- **"Submit" / "Submission" → "Contribute" / "Contribution"** (user-facing).
- **"Approve" / "Approval" → "Endorse" / "Endorsement"** (user-facing) — pending
  final word choice.

Internal identifiers (tables like `activity_submissions`, `submission_status`
enums, API paths) are left unchanged; only user-facing copy changes.

---

## RAG ingest & chunking

**Verbatim, semantically chunked.** Document chunks are stored and returned
**verbatim** (paragraph-aware, ~1200 chars, 150 overlap). We do **not** summarize
or "extract the important points" at ingest — that would drop the long tail
(relevance is set by the coach's later query, not by the model at ingest) and bake
in interpretation/error into what the coaching model later cites. Distillation is
available only as human-curated **manual samples**.

**Full-text extraction.** RAG extracts the whole document (the 12k-char cap in
`extractText` is for message-attachment peeks only). Pipeline: native text →
normalize-to-PDF → OCR (scanned) → vision model (charts/tables). The vision model
reconstructs **tables as Markdown** and transcribes every label/number.

**Contextual Retrieval (locked).** When enabled (`rag_contextual_retrieval`, default
on), the **ingest model** writes a short header situating each chunk within its
whole document; that header is embedded **together with** the verbatim chunk, while
the chunk itself is stored/returned unchanged. This is asymmetric indexing done
safely — the model's whole-document understanding shapes the embedding without
paraphrasing the source. One ingest-model call per chunk; applies to newly ingested
or re-processed documents.

**Ingest model.** Background ingest text tasks (auto-description, per-chunk context)
run on `ollama_ingest_model`, defaulting to the coaching model when unset. Prefer a
local `ollama:<name>` so ingest stays offline and free. Document descriptions are
auto-drafted from the text (editable later); the upload form no longer asks for one.
