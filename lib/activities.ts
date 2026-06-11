/**
 * The fixed activity taxonomy (see docs/activity-taxonomy.md). Four categories;
 * category determines who decides completion, whether AI is involved, and the
 * default gating mode. These are the building blocks dragged onto the canvas.
 */

export type ActivityCategory = "reflecting" | "inquiry" | "observation" | "implementation";

export type Gating = "OPEN" | "REVIEWED";

export interface ActivityType {
  key: string;
  label: string;
  category: ActivityCategory;
  defaultGating: Gating;
}

export const CATEGORY_META: Record<
  ActivityCategory,
  { label: string; blurb: string; color: string }
> = {
  reflecting: {
    label: "Reflecting & Solving",
    blurb: "AI-involved conversations; coach reviews.",
    color: "#2563eb", // blue
  },
  inquiry: {
    label: "Input & Inquiry",
    blurb: "Partner self-attests after producing a reflective piece.",
    color: "#16a34a", // green
  },
  observation: {
    label: "Observation & Being Observed",
    blurb: "Coach-determined completion; no AI.",
    color: "#9333ea", // purple
  },
  implementation: {
    label: "Implementation",
    blurb: "Real-world action; coach confirms.",
    color: "#ea580c", // orange
  },
};

export const ACTIVITY_TYPES: ActivityType[] = [
  // Category 1 — Reflecting & Solving (default REVIEWED)
  { key: "describe_current_reality", label: "Describe Current Reality", category: "reflecting", defaultGating: "REVIEWED" },
  { key: "develop_a_goal", label: "Develop a Goal", category: "reflecting", defaultGating: "REVIEWED" },
  { key: "identify_root_cause", label: "Identify Root Cause", category: "reflecting", defaultGating: "REVIEWED" },
  { key: "define_conditions_for_success", label: "Define Conditions for Success", category: "reflecting", defaultGating: "REVIEWED" },
  { key: "interrogate_an_assumption", label: "Interrogate an Assumption", category: "reflecting", defaultGating: "REVIEWED" },
  { key: "navigate_a_stakeholder_situation", label: "Navigate a Stakeholder Situation", category: "reflecting", defaultGating: "REVIEWED" },
  { key: "take_a_perspective", label: "Take a Perspective", category: "reflecting", defaultGating: "REVIEWED" },
  { key: "reflect_on_a_measured_outcome", label: "Reflect on a Measured Outcome", category: "reflecting", defaultGating: "REVIEWED" },

  // Category 2 — Input & Inquiry (default OPEN)
  { key: "read_a_text", label: "Read a Text", category: "inquiry", defaultGating: "OPEN" },
  { key: "analyze_data", label: "Analyze Data", category: "inquiry", defaultGating: "OPEN" },
  { key: "interview_a_stakeholder", label: "Interview a Stakeholder", category: "inquiry", defaultGating: "OPEN" },
  { key: "observe_a_classroom", label: "Observe a Classroom", category: "inquiry", defaultGating: "OPEN" },
  { key: "review_student_work", label: "Review Student Work", category: "inquiry", defaultGating: "OPEN" },
  { key: "survey_your_team", label: "Survey Your Team", category: "inquiry", defaultGating: "OPEN" },
  { key: "research_a_strategy", label: "Research a Strategy", category: "inquiry", defaultGating: "OPEN" },

  // Category 3 — Observation & Being Observed (default REVIEWED)
  { key: "host_coachs_observation", label: "Host Coach's Observation", category: "observation", defaultGating: "REVIEWED" },
  { key: "record_and_review_own_practice", label: "Record and Review Own Practice", category: "observation", defaultGating: "REVIEWED" },
  { key: "conduct_a_peer_observation", label: "Conduct a Peer Observation", category: "observation", defaultGating: "REVIEWED" },
  { key: "participate_in_a_learning_walk", label: "Participate in a Learning Walk", category: "observation", defaultGating: "REVIEWED" },

  // Category 4 — Implementation (default REVIEWED)
  { key: "try_a_strategy", label: "Try a Strategy", category: "implementation", defaultGating: "REVIEWED" },
  { key: "co_teach_a_session", label: "Co-Teach a Session", category: "implementation", defaultGating: "REVIEWED" },
  { key: "facilitate_a_meeting", label: "Facilitate a Meeting", category: "implementation", defaultGating: "REVIEWED" },
  { key: "deliver_professional_development", label: "Deliver Professional Development", category: "implementation", defaultGating: "REVIEWED" },
  { key: "implement_a_plan", label: "Implement a Plan", category: "implementation", defaultGating: "REVIEWED" },
];

export const ACTIVITY_BY_KEY: Record<string, ActivityType> = Object.fromEntries(
  ACTIVITY_TYPES.map((a) => [a.key, a])
);
