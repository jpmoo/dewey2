/**
 * The fixed activity taxonomy (see docs/activity-taxonomy.md). Four categories;
 * category determines who decides completion, whether AI is involved, and the
 * default gating mode. These are the building blocks dragged onto the canvas.
 */

export type ActivityCategory = "reflecting" | "inquiry" | "observation" | "implementation";

export type Gating = "OPEN" | "REVIEWED";

/** Partner-/coach-facing labels for each gating mode. */
export const GATING_LABEL: Record<Gating, string> = {
  OPEN: "Partner Attests",
  REVIEWED: "Coach Approves",
};

export interface ActivityType {
  key: string;
  label: string;
  category: ActivityCategory;
  defaultGating: Gating;
  /** Pre-filled partner-facing instructions when an activity is first added. */
  defaultInstructions: string;
  /** What the partner is expected to produce (the activity's output). */
  defaultArtifact: string;
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
  { key: "describe_current_reality", label: "Describe Current Reality", category: "reflecting", defaultGating: "REVIEWED", defaultInstructions: "Describe the current state of your problem or practice gap as specifically as you can — what's happening now, for whom, and how you know.", defaultArtifact: "A written description of the current reality." },
  { key: "develop_a_goal", label: "Develop a Goal", category: "reflecting", defaultGating: "REVIEWED", defaultInstructions: "Work toward a specific, measurable improvement goal: what will be different, by how much, and by when.", defaultArtifact: "A written goal statement (specific, measurable, and time-bound)." },
  { key: "identify_root_cause", label: "Identify Root Cause", category: "reflecting", defaultGating: "REVIEWED", defaultInstructions: "Surface and test hypotheses about why this problem persists. Look past the symptoms to the underlying causes.", defaultArtifact: "A short write-up of the likely root cause(s) and supporting evidence." },
  { key: "define_conditions_for_success", label: "Define Conditions for Success", category: "reflecting", defaultGating: "REVIEWED", defaultInstructions: "Describe concretely what solving this problem will look like — the conditions and evidence that would tell you you've succeeded.", defaultArtifact: "A written description of what success looks like." },
  { key: "project_a_measured_outcome", label: "Project a Measured Outcome", category: "reflecting", defaultGating: "REVIEWED", defaultInstructions: "Forecast the measurable result you expect from this work — name the metric, your target value, and the timeframe — and explain the reasoning behind the projection.", defaultArtifact: "A written projection: the metric, expected target, timeframe, and rationale." },
  { key: "interrogate_an_assumption", label: "Interrogate an Assumption", category: "reflecting", defaultGating: "REVIEWED", defaultInstructions: "Examine a belief or mental model you hold about this situation. What are you assuming, and what changes if it isn't true?", defaultArtifact: "A written reflection on the assumption examined and what shifted." },
  { key: "navigate_a_stakeholder_situation", label: "Navigate a Stakeholder Situation", category: "reflecting", defaultGating: "REVIEWED", defaultInstructions: "Map the stakeholders involved and develop a strategy for influencing or working with them.", defaultArtifact: "A stakeholder map and an influence strategy." },
  { key: "take_a_perspective", label: "Take a Perspective", category: "reflecting", defaultGating: "REVIEWED", defaultInstructions: "Step into another person's point of view. What do they see, value, and worry about in this situation?", defaultArtifact: "A written account of the other person's perspective." },
  { key: "reflect_on_a_measured_outcome", label: "Reflect on a Measured Outcome", category: "reflecting", defaultGating: "REVIEWED", defaultInstructions: "Examine your results and decide whether to declare success, refine your approach, or revisit the goal.", defaultArtifact: "A written reflection on the results and your next decision." },

  // Category 2 — Input & Inquiry (default OPEN)
  { key: "read_a_text", label: "Read a Text", category: "inquiry", defaultGating: "OPEN", defaultInstructions: "Read the assigned article, chapter, or section and capture your key takeaways and the questions it raised.", defaultArtifact: "Reading notes with key takeaways and questions." },
  { key: "analyze_data", label: "Analyze Data", category: "inquiry", defaultGating: "OPEN", defaultInstructions: "Examine the relevant data (student performance, observation, survey, etc.) and note the patterns and surprises you find.", defaultArtifact: "A short data summary noting patterns and implications." },
  { key: "interview_a_stakeholder", label: "Interview a Stakeholder", category: "inquiry", defaultGating: "OPEN", defaultInstructions: "Conduct a structured conversation to gather this person's perspective. Prepare your questions and record what you learn.", defaultArtifact: "Interview notes and key insights." },
  { key: "observe_a_classroom", label: "Observe a Classroom", category: "inquiry", defaultGating: "OPEN", defaultInstructions: "Conduct or attend a classroom observation and capture what you notice against your focus.", defaultArtifact: "Observation notes against the focus." },
  { key: "review_student_work", label: "Review Student Work", category: "inquiry", defaultGating: "OPEN", defaultInstructions: "Examine student work against a standard or rubric and note what it reveals about learning.", defaultArtifact: "A summary of what the student work reveals." },
  { key: "survey_your_team", label: "Survey Your Team", category: "inquiry", defaultGating: "OPEN", defaultInstructions: "Gather structured input from your colleagues and summarize what you hear.", defaultArtifact: "A summary of the team's input." },
  { key: "research_a_strategy", label: "Research a Strategy", category: "inquiry", defaultGating: "OPEN", defaultInstructions: "Investigate an approach or intervention before trying it. Note how it works, the evidence behind it, and its fit for your context.", defaultArtifact: "A brief write-up of the strategy and its fit for your context." },

  // Category 3 — Observation & Being Observed (default REVIEWED)
  { key: "host_coachs_observation", label: "Host Coach's Observation", category: "observation", defaultGating: "REVIEWED", defaultInstructions: "Arrange for your coach to observe your practice, in person or via recording, and note what you'd like feedback on.", defaultArtifact: "A completed observation (with any notes or recording)." },
  { key: "record_and_review_own_practice", label: "Record and Review Own Practice", category: "observation", defaultGating: "REVIEWED", defaultInstructions: "Record yourself in practice, then review the recording and note what you see.", defaultArtifact: "A recording and your review notes." },
  { key: "conduct_a_peer_observation", label: "Conduct a Peer Observation", category: "observation", defaultGating: "REVIEWED", defaultInstructions: "Observe a colleague's practice and capture what you notice and what you'll borrow.", defaultArtifact: "Peer-observation notes and takeaways." },
  { key: "participate_in_a_learning_walk", label: "Participate in a Learning Walk", category: "observation", defaultGating: "REVIEWED", defaultInstructions: "Take part in a structured walkthrough and capture patterns across the classrooms you visit.", defaultArtifact: "Learning-walk notes capturing patterns observed." },

  // Category 4 — Implementation (default REVIEWED)
  { key: "try_a_strategy", label: "Try a Strategy", category: "implementation", defaultGating: "REVIEWED", defaultInstructions: "Implement the specific strategy in your practice, then capture how it went and what you'd adjust.", defaultArtifact: "A reflection on the attempt and the adjustments you'd make." },
  { key: "co_teach_a_session", label: "Co-Teach a Session", category: "implementation", defaultGating: "REVIEWED", defaultInstructions: "Co-deliver a session with your coach or a colleague, then debrief what worked and what you'd change.", defaultArtifact: "A co-teaching debrief / reflection." },
  { key: "facilitate_a_meeting", label: "Facilitate a Meeting", category: "implementation", defaultGating: "REVIEWED", defaultInstructions: "Lead a team, PLG, or staff meeting with an intentional structure, then reflect on your facilitation.", defaultArtifact: "The meeting agenda/structure and a reflection on facilitation." },
  { key: "deliver_professional_development", label: "Deliver Professional Development", category: "implementation", defaultGating: "REVIEWED", defaultInstructions: "Design and deliver professional development to your team, then gather feedback and reflect.", defaultArtifact: "The PD materials and a reflection on delivery." },
  { key: "implement_a_plan", label: "Implement a Plan", category: "implementation", defaultGating: "REVIEWED", defaultInstructions: "Execute the multi-step action plan you developed, tracking progress against the steps.", defaultArtifact: "Evidence of progress against the plan's steps." },
];

export const ACTIVITY_BY_KEY: Record<string, ActivityType> = Object.fromEntries(
  ACTIVITY_TYPES.map((a) => [a.key, a])
);
