"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { apiFetch } from "@/lib/api-client";

const TemplateReadOnly = dynamic(
  () => import("@/components/admin/TemplateCanvas").then((m) => m.TemplateReadOnly),
  { ssr: false }
);

type Dot = "gray" | "green" | "yellow" | "red";

interface ConvProgress {
  threadId: number;
  threadName: string;
  planId: number | null;
  planName: string | null;
  planDescription: string | null;
  status: Dot;
  complete: boolean;
  currentActivityLabel: string | null;
  avgDaysToComplete: number | null;
}
interface PartnerProgress {
  userId: number;
  fullName: string;
  username: string;
  role: string;
  overall: Dot;
  allComplete: boolean;
  conversations: ConvProgress[];
}
interface Building {
  id: number;
  name: string;
  districtName?: string | null;
}
interface Report {
  canAccess: boolean;
  buildings: Building[];
  buildingId: number | null;
  partners: PartnerProgress[];
}

const DOT_COLOR: Record<Dot, string> = {
  gray: "#9ca3af",
  green: "#16a34a",
  yellow: "#eab308",
  red: "#dc2626",
};

const ROLE_LABEL: Record<string, string> = {
  partner: "Partner",
  site_leader: "Site Leader",
  deputy_site_leader: "Deputy Site Leader",
  coach: "Coach",
  admin: "Admin",
};

function StatusDot({ status, complete, title }: { status: Dot; complete?: boolean; title?: string }) {
  return (
    <span
      className="relative inline-flex h-3.5 w-3.5 items-center justify-center rounded-full"
      style={{ background: DOT_COLOR[status] }}
      title={title}
      aria-label={title}
    >
      {complete && (
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )}
    </span>
  );
}

export function ProgressReport() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buildingId, setBuildingId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [viewPlanId, setViewPlanId] = useState<number | null>(null);

  const load = useCallback((bid: number | null) => {
    const qs = bid != null ? `?buildingId=${bid}` : "";
    apiFetch<Report>(`/api/progress${qs}`)
      .then((d) => {
        setReport(d);
        setBuildingId(d.buildingId);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load the report"));
  }, []);

  useEffect(() => {
    load(null);
  }, [load]);

  const toggle = (uid: number) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });

  const q = query.trim().toLowerCase();
  const partners = useMemo(() => {
    if (!report) return [];
    if (!q) return report.partners;
    return report.partners.filter((p) =>
      [p.fullName, p.username, ROLE_LABEL[p.role] ?? p.role].join(" ").toLowerCase().includes(q)
    );
  }, [report, q]);

  if (error) return <p className="text-red-600">{error}</p>;
  if (!report) return <p className="text-dewey-mute">Loading the Progress report…</p>;
  if (!report.canAccess) return <p className="text-dewey-mute">This report isn&apos;t available for your role.</p>;
  if (report.buildings.length === 0)
    return <p className="text-dewey-mute">You aren&apos;t assigned to a building yet, so there&apos;s no report to show.</p>;

  const showBuildingPicker = report.buildings.length > 1;

  return (
    <div className="space-y-4">
      {/* Controls: search (mirrors the users page) + building dropdown when >1 */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="dewey-input max-w-xs"
          placeholder="Search people…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {showBuildingPicker && (
          <select
            className="dewey-input max-w-xs"
            value={buildingId ?? ""}
            onChange={(e) => {
              const v = Number(e.target.value);
              setBuildingId(v);
              setReport(null);
              load(v);
            }}
          >
            {report.buildings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.districtName ? `${b.districtName} · ${b.name}` : b.name}
              </option>
            ))}
          </select>
        )}
        <span className="text-xs text-dewey-mute">
          {partners.length} {partners.length === 1 ? "person" : "people"}
        </span>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-dewey-mute">
        <span className="flex items-center gap-1.5"><StatusDot status="gray" /> Open (no plan)</span>
        <span className="flex items-center gap-1.5"><StatusDot status="green" /> On track (&lt;3 days)</span>
        <span className="flex items-center gap-1.5"><StatusDot status="yellow" /> 3–5 days</span>
        <span className="flex items-center gap-1.5"><StatusDot status="red" /> &gt;5 days</span>
        <span className="flex items-center gap-1.5"><StatusDot status="green" complete /> Plan complete</span>
      </div>

      <div className="divide-y divide-dewey-border rounded-lg border border-dewey-border">
        {partners.length === 0 ? (
          <p className="p-4 text-sm text-dewey-mute">No one matches your search.</p>
        ) : (
          partners.map((p) => {
            const open = expanded.has(p.userId);
            return (
              <div key={p.userId}>
                <button
                  type="button"
                  onClick={() => toggle(p.userId)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-dewey-surface-2"
                >
                  <span className="text-dewey-mute">{open ? "▾" : "▸"}</span>
                  <StatusDot
                    status={p.overall}
                    complete={p.allComplete && p.overall === "green"}
                    title="Overall status"
                  />
                  <span className="font-medium">{p.fullName}</span>
                  <span className="text-xs text-dewey-mute">{ROLE_LABEL[p.role] ?? p.role}</span>
                  <span className="ml-auto text-xs text-dewey-mute">
                    {p.conversations.length} conversation{p.conversations.length === 1 ? "" : "s"}
                  </span>
                </button>

                {open && (
                  <div className="px-4 pb-3">
                    {p.conversations.length === 0 ? (
                      <p className="py-2 text-sm text-dewey-mute">No unarchived conversations.</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs uppercase tracking-wide text-dewey-mute">
                            <th className="w-10 py-1 font-medium">Status</th>
                            <th className="py-1 font-medium">Plan</th>
                            <th className="w-40 py-1 text-right font-medium">Avg days / activity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.conversations.map((c) => (
                            <tr key={c.threadId} className="border-t border-dewey-border/60 align-top">
                              <td className="py-2">
                                <StatusDot
                                  status={c.status}
                                  complete={c.complete}
                                  title={
                                    c.complete
                                      ? "Plan complete"
                                      : c.planId == null
                                      ? "Open conversation"
                                      : `Current activity status`
                                  }
                                />
                              </td>
                              <td className="py-2">
                                {c.planId != null ? (
                                  <div>
                                    <button
                                      type="button"
                                      className="text-dewey-accent hover:underline"
                                      onClick={() => setViewPlanId(c.planId)}
                                    >
                                      {c.planName}
                                    </button>
                                    {c.currentActivityLabel && !c.complete && (
                                      <span className="ml-2 text-xs text-dewey-mute">
                                        Current: {c.currentActivityLabel}
                                      </span>
                                    )}
                                    {c.planDescription && (
                                      <div className="whitespace-pre-wrap text-xs text-dewey-mute">
                                        {c.planDescription}
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-xs text-dewey-mute">
                                    This is an open conversation that does not (or does not yet) have a plan.
                                  </span>
                                )}
                              </td>
                              <td className="py-2 text-right tabular-nums">
                                {c.planId != null && c.avgDaysToComplete != null
                                  ? c.avgDaysToComplete
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {viewPlanId != null && (
        <TemplateReadOnly
          templateId={viewPlanId}
          templatesBase="/api/progress/plan"
          onClose={() => setViewPlanId(null)}
        />
      )}
    </div>
  );
}
