"use client";

type PlanOutline = {
  phases: { name: string; color: string | null; activities: number }[];
  unphased: number;
};

const FALLBACK_COLOR = "#2563eb";
const COL_W = 96;
const GAP = 22;
const HEAD = 26;
const BOX_H = 14;
const BOX_GAP = 6;
const MAX_BOXES = 4;

/**
 * A medium-sized drawing of a plan for its chat bubble: each phase is a tinted
 * column (in order, joined by arrows) holding one small box per activity.
 * Clicking it does what "View plan" does.
 */
export function PlanThumbnail({
  outline,
  name,
  onOpen,
}: {
  outline: PlanOutline;
  name: string;
  onOpen: () => void;
}) {
  const cols = [
    ...outline.phases.map((p) => ({ name: p.name, color: p.color || FALLBACK_COLOR, activities: p.activities })),
    ...(outline.unphased > 0 ? [{ name: "Other", color: "#6b7280", activities: outline.unphased }] : []),
  ];
  if (cols.length === 0) return null;

  const tallest = Math.min(MAX_BOXES, Math.max(1, ...cols.map((c) => c.activities)));
  const overflow = cols.some((c) => c.activities > MAX_BOXES);
  const colH = HEAD + tallest * (BOX_H + BOX_GAP) + (overflow ? 14 : 4);
  const width = cols.length * COL_W + (cols.length - 1) * GAP;
  const height = colH + 8;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`View ${name}`}
      aria-label={`View plan: ${name}`}
      className="mt-2 block w-full max-w-md overflow-hidden rounded-md border border-dewey-border bg-dewey-surface p-2 transition-colors hover:border-dewey-accent/60"
    >
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" style={{ maxHeight: 180 }} role="img">
        <defs>
          <marker id="plan-thumb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" className="fill-dewey-mute" />
          </marker>
        </defs>
        {cols.map((c, i) => {
          const x = i * (COL_W + GAP);
          const shown = Math.min(c.activities, MAX_BOXES);
          const label = c.name.length > 16 ? `${c.name.slice(0, 15)}…` : c.name;
          return (
            <g key={i}>
              <rect x={x} y={4} width={COL_W} height={colH} rx={10} fill={c.color} fillOpacity={0.12} stroke={c.color} strokeOpacity={0.5} />
              <text x={x + 8} y={20} fontSize={10} fontWeight={600} fill={c.color}>
                {`${i + 1}. ${label}`}
              </text>
              {Array.from({ length: shown }, (_, j) => (
                <rect
                  key={j}
                  x={x + 10}
                  y={4 + HEAD + j * (BOX_H + BOX_GAP)}
                  width={COL_W - 20}
                  height={BOX_H}
                  rx={3}
                  className="fill-dewey-surface"
                  stroke={c.color}
                  strokeOpacity={0.7}
                />
              ))}
              {c.activities > MAX_BOXES && (
                <text x={x + COL_W / 2} y={4 + HEAD + MAX_BOXES * (BOX_H + BOX_GAP) + 6} fontSize={9} textAnchor="middle" className="fill-dewey-mute">
                  +{c.activities - MAX_BOXES} more
                </text>
              )}
              {c.activities === 0 && (
                <text x={x + COL_W / 2} y={4 + HEAD + 10} fontSize={9} textAnchor="middle" className="fill-dewey-mute">
                  No activities
                </text>
              )}
              {i < cols.length - 1 && (
                <line
                  x1={x + COL_W + 2}
                  y1={4 + colH / 2}
                  x2={x + COL_W + GAP - 3}
                  y2={4 + colH / 2}
                  className="stroke-dewey-mute"
                  strokeWidth={1.5}
                  markerEnd="url(#plan-thumb-arrow)"
                />
              )}
            </g>
          );
        })}
      </svg>
    </button>
  );
}
