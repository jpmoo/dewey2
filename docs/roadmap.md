# Dewey 2.0 — Roadmap (Next to Build)

The main spine of the platform is complete. Current phase is **test & polish**.
These are bookmarked modules to build later — not yet started, not yet specced in
detail.

---

## Reporting tool

Graphs, charts, lists, etc. Exact contents TBD. The intent is to surface activity
across the platform — plans, activities, phases, partnerships, messages — in a
visual/reportable form. Scope and specific reports to be defined when we pick it up.

## Building Administrator role

A new user role scoped to a single building (distinct from the org-wide system
`admin`). A building administrator can:

- See everything happening in their building.
- Participate in all conversations within their building.
- Report on their building.

Explicitly **not** required: approving plans or submissions — that stays with
coaches (and admins). This role is oversight + participation + reporting, not a
gatekeeper.

---

## Deferred from the original spec

Not part of the two modules above, but still open against `CLAUDE.md` /
`docs/decisions.md`:

- **System-provided starter templates** — Impact Cycle, Problem of Practice, book
  study, shipped in the global library. (Today the AI can generate a full-framework
  arc on request, and admins can publish to global, but no ready-made templates ship.)
- **"Reopen a completed activity for remediation"** — a coach action at phase exit
  to send the partner back to redo an already-approved activity. (Today: return a
  *pending* submission with feedback, or edit the active plan.)
- **Auto-surfaced phase-exit analysis** — proactively present the AI's exit-condition
  analysis to the coach rather than on-demand via the review-modal consult.
