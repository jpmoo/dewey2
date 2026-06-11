# Dewey 2.0 — Claude Code Orientation

## What This Is

Dewey is an educational leadership coaching platform. Version 1.0 (in `reference/dewey1.0/`) is a working Next.js app that pairs school and district leaders with an AI coach for structured Socratic conversations. It uses a two-model stack: a local Ollama model for routing/safety, and Claude (via API) for the actual coaching.

Version 2.0 expands the platform significantly. The core shift: **the AI is no longer the primary coach.** Human coaches now hold that role. The AI becomes a companion tool supporting the human coaching relationship.

---

## New in 2.0: Roles

Two new user types are introduced:

- **Coach** — a human professional who builds coaching plans, monitors partner progress, reviews artifacts, and approves phase advancement
- **Partner** — the person being coached (previously just "the user/leader")

The existing AI conversation engine remains, repositioned as a tool coaches deploy within a coaching plan rather than the primary experience.

---

## Core Object Model

```
Arc
└── Phase (ordered)
    └── Activity (ordered)
```

- **Arc** — the full coaching journey (e.g., an Impact Cycle, a book study, a Problem of Practice)
- **Phase** — a named stage within an arc (e.g., "Identify", "Learn", "Improve")
- **Activity** — a discrete unit of work within a phase

**Key distinction:**
- Activities have **done states** (how we know this specific activity is complete)
- Phases have **exit conditions** (the criteria evaluated when all activities are done, before the coach approves advancement)

---

## Activity Taxonomy

Activities fall into four categories. Category determines who/what decides completion and whether AI is involved.

### 1. Reflecting & Solving
AI-involved conversational activities. Completion determined by AI judgment or coach review.

Examples: Describe Current Reality, Develop a Goal, Reflect on a Measured Outcome, Interrogate an Assumption, Navigate a Stakeholder Situation

### 2. Input & Inquiry
Partner self-attests completion upon producing a reflective piece.

Examples: Read a Text, Analyze Data, Interview a Stakeholder, Observe a Classroom, Review Student Work

### 3. Observation & Being Observed
Coach-determined completion. AI not available.

Examples: Host Coach's Observation, Record and Review Own Practice, Conduct a Peer Observation

### 4. Implementation
Coach-determined completion.

Examples: Try a Strategy, Co-Teach a Session, Facilitate a Meeting, Deliver Professional Development

---

## Activity Gating (Done States)

Two gating modes determine how an activity reaches "done":

- **OPEN** — partner self-attests completion (clicks "Mark Complete")
- **REVIEWED** — coach must approve via a message center thread; the activity surfaces to the coach for review

---

## Phase Exit Flow

When a partner completes the final activity in a phase:

1. AI evaluates all phase artifacts against the phase's exit conditions
2. AI surfaces an analysis with reasoning **to the coach only**
3. Coach either approves advancement to the next phase, or reopens specific activities for remediation

**The AI never communicates a readiness verdict directly to the partner.** The coach is the decision-maker.

---

## Canvas-Based Plan Builder

Coaches build coaching plans using a canvas interface:

- Drag activities onto the canvas and connect them into phases
- Drag phases and connect them into arcs
- System provides templates (Impact Cycle, Problem of Practice, book study) that coaches can use as starting points or customize

---

## What to Carry Forward from 1.0

These patterns from `reference/dewey1.0/` are worth understanding and adapting (don't import directly):

- **Two-model stack** — Ollama for routing/compliance, Claude API for reasoning. This architecture continues in 2.0.
- **Arc/phase JSON configs** — `coaching_arcs.json` and `coaching_phases.json` define the existing coaching journey shapes. The 2.0 template library will include these as system-provided arc templates.
- **RAG integration** — the RAGDoll retrieval pattern (semantic similarity against org documents) carries forward
- **JSON contract for AI responses** — structured output with reasoning fields is a deliberate pattern to preserve
- **Compliance screen** — the Ollama-based pre-generation safety check should be retained

---

## What NOT to Do

- **Do not treat `reference/` as importable code.** It's context. Read it to understand patterns; don't wire it in directly.
- **Do not add composite activity types.** Things like PDSA cycles or equity audits are template-level constructs (arcs or phases), not activity types.
- **Do not model artifact creation as a standalone activity type.** Artifacts are outputs that emerge from other activities.
- **Do not create "commitment" activities.** Commitments are byproducts of goal-setting within impact cycles, not independent activity types.
- **Do not let the AI communicate phase readiness to the partner.** That verdict belongs to the coach.

---

## Tech Stack (carry forward from 1.0)

- Next.js 14 (App Router), TypeScript, Tailwind CSS
- NextAuth.js for authentication
- Postgres for persistent data
- Ollama for local model serving (structural/routing calls)
- Anthropic Claude API for coaching and AI reasoning
- RAGDoll for retrieval-augmented generation

---

## Reference

- `reference/dewey1.0/` — full working codebase of the original platform
- `docs/decisions.md` — locked product decisions; consult before proposing alternatives
- `docs/activity-taxonomy.md` — full activity type reference with done conditions
- `docs/platform-reference.pdf` — original platform reference guide (1.0 architecture)
