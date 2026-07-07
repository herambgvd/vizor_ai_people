"use client";

// People-analytics operations overview — the authenticated home view. Driven by the
// analytics summary rollup (GET /people/analytics/summary): live occupancy now,
// directional in/out line-counting with net occupancy, per-scenario event counts,
// and a per-camera breakdown. Polls ~5s via TanStack Query.

import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";

import { PageHeader, Spinner } from "@/web/kit";
import { api } from "@/web/api";
import { useAuth } from "@/web/auth";

import { EVENT_LABEL, SCENARIOS } from "./shared";
import { useFeatures } from "./useFeatures";

// event_type -> scenario meta (icon + hex colour).
const META = Object.fromEntries(SCENARIOS.map((s) => [s.event_type, s]));

function KpiCard({ icon, color, label, value, sublabel, loading }) {
  return (
    <div className="rounded-xl border border-card-border bg-card p-4 flex items-center gap-3.5">
      <div className={`h-12 w-12 rounded-full bg-hover flex items-center justify-center shrink-0 ${color}`}>
        <Icon icon={icon} className="text-xl" />
      </div>
      <div className="min-w-0">
        {loading ? (
          <div className="h-7 w-12 rounded bg-hover animate-pulse" />
        ) : (
          <div className="text-2xl font-semibold text-foreground leading-tight tabular-nums">{value ?? "—"}</div>
        )}
        <div className="text-[13px] font-medium text-foreground truncate">{label}</div>
        {sublabel && <div className="text-[11px] text-muted truncate">{sublabel}</div>}
      </div>
    </div>
  );
}

// One in/out/net stat inside the People-counting card.
function CountStat({ icon, color, label, value, loading }) {
  return (
    <div className="flex-1 min-w-0 text-center">
      <div className={`flex items-center justify-center gap-1.5 text-[11px] uppercase tracking-wider ${color}`}>
        <Icon icon={icon} className="text-sm" />{label}
      </div>
      {loading
        ? <div className="mx-auto mt-1 h-8 w-14 rounded bg-hover animate-pulse" />
        : <div className="mt-0.5 text-3xl font-semibold text-foreground tabular-nums">{value ?? "—"}</div>}
    </div>
  );
}

export default function PeopleDashboard() {
  const { user } = useAuth();
  const { isLicensed } = useFeatures();

  // Only surface scenarios the client is licensed for.
  const scenarios = SCENARIOS.filter((s) => isLicensed(s.key));
  const licensedTypes = scenarios.map((s) => s.event_type);
  const countingOn = isLicensed("counting");

  const summaryQ = useQuery({
    queryKey: ["people-summary", 24],
    queryFn: () => api.get("/people/analytics/summary", { params: { since_hours: 24 } }).then((r) => r.data),
    refetchInterval: 5000,
  });
  const camsQ = useQuery({
    queryKey: ["people-cameras"],
    queryFn: () => api.get("/people/cameras").then((r) => r.data),
    refetchInterval: 15000,
  });

  const s = summaryQ.data || {};
  const totals = s.totals || { in: 0, out: 0, net: 0, live: 0, by_type: {} };
  const byType = totals.by_type || {};
  const rows = s.cameras || [];

  const cameras = camsQ.data || [];
  const camsOnline = cameras.filter((c) => c.status === "online").length;
  const camsAnalysing = cameras.filter((c) => c.analytics_enabled).length;
  const camsTotal = cameras.length;

  const events24h = licensedTypes.reduce((sum, t) => sum + (byType[t] || 0), 0);
  const nameById = Object.fromEntries(cameras.map((c) => [String(c.id), c]));
  const sumLoading = summaryQ.isLoading;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome, ${user?.full_name || user?.email || "operator"}`}
        subtitle="People analytics — live occupancy, in/out counting and scenario alerts (last 24 hours)."
      />

      {/* KPI row — headline occupancy + counting + health */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon="heroicons-outline:user-group" color="text-green-500" label="Live occupancy"
          value={totals.live} sublabel="people on camera now" loading={sumLoading} />
        {countingOn && (
          <KpiCard icon="heroicons-outline:scale" color="text-indigo-400" label="Net occupancy"
            value={totals.net} sublabel="in − out (24h)" loading={sumLoading} />
        )}
        <KpiCard icon="heroicons-outline:video-camera" color="text-blue-400" label="Cameras online"
          value={`${camsOnline} / ${camsTotal}`} sublabel={`${camsAnalysing} analysing`} loading={camsQ.isLoading} />
        <KpiCard icon="heroicons-outline:bell-alert" color="text-amber-500" label="Events (24h)"
          value={events24h} sublabel="across all cameras" loading={sumLoading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* People counting — the in/out line-counting deliverable (only when licensed) */}
        {countingOn && (
          <div className="rounded-xl border border-card-border bg-card p-4 flex flex-col">
            <div className="flex items-center gap-2 mb-4">
              <Icon icon="heroicons-outline:arrows-right-left" className="text-blue-400" />
              <h2 className="text-sm font-semibold text-foreground">People counting</h2>
              <span className="ml-auto text-[11px] text-muted">last 24h</span>
            </div>
            <div className="flex items-center justify-between gap-2 flex-1">
              <CountStat icon="heroicons-outline:arrow-right-on-rectangle" color="text-green-500" label="In" value={totals.in} loading={sumLoading} />
              <div className="h-10 w-px bg-card-border shrink-0" />
              <CountStat icon="heroicons-outline:arrow-left-on-rectangle" color="text-red-400" label="Out" value={totals.out} loading={sumLoading} />
              <div className="h-10 w-px bg-card-border shrink-0" />
              <CountStat icon="heroicons-outline:scale" color="text-indigo-400" label="Net" value={totals.net} loading={sumLoading} />
            </div>
            <p className="text-[11px] text-muted mt-4 text-center">Net occupancy = people counted in minus people counted out across all counting lines.</p>
          </div>
        )}

        {/* Events by scenario — one tile per LICENSED scenario, each links to its page */}
        {scenarios.length > 0 && (
          <div className={`${countingOn ? "lg:col-span-2" : "lg:col-span-3"} rounded-xl border border-card-border bg-card p-4`}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-foreground">Events by scenario</h2>
              {summaryQ.isFetching && <Spinner className="h-3 w-3" />}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {scenarios.map((sc) => {
                const n = byType[sc.event_type] || 0;
                return (
                  <Link key={sc.key} href={`/${sc.key}`} className="rounded-lg border border-card-border bg-background/40 p-3 hover:bg-hover transition"
                    style={{ borderLeft: `3px solid ${sc.color}` }}>
                    <div className="flex items-center gap-1.5 text-[11px] text-muted uppercase tracking-wider truncate">
                      <Icon icon={sc.icon} style={{ color: sc.color }} className="shrink-0" />
                      <span className="truncate">{sc.label}</span>
                    </div>
                    {sumLoading
                      ? <div className="mt-1 h-7 w-10 rounded bg-hover animate-pulse" />
                      : <div className="mt-0.5 text-2xl font-semibold text-foreground tabular-nums">{n}</div>}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Per-camera breakdown */}
      <div className="rounded-xl border border-card-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-card-border">
          <h2 className="text-sm font-semibold text-foreground">Per-camera breakdown</h2>
          <Link href="/cameras" className="text-xs text-muted hover:text-foreground transition">Manage →</Link>
        </div>
        {sumLoading ? (
          <div className="flex justify-center py-14"><Spinner /></div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-muted py-12 gap-2">
            <Icon icon="heroicons-outline:video-camera-slash" className="text-3xl" />
            <span className="text-sm">No cameras yet.</span>
            <Link href="/cameras" className="text-xs text-blue-400 hover:underline">Add a camera →</Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-muted border-b border-card-border">
                  <th className="px-4 py-2.5 font-medium">Camera</th>
                  <th className="px-3 py-2.5 font-medium text-right">Live</th>
                  {countingOn && <>
                    <th className="px-3 py-2.5 font-medium text-right">In</th>
                    <th className="px-3 py-2.5 font-medium text-right">Out</th>
                    <th className="px-3 py-2.5 font-medium text-right">Net</th>
                  </>}
                  {scenarios.map((sc) => (
                    <th key={sc.key} className="px-3 py-2.5 font-medium text-right">
                      <span className="inline-flex items-center gap-1 justify-end" title={sc.label}>
                        <Icon icon={sc.icon} style={{ color: sc.color }} />
                        <span className="hidden xl:inline">{EVENT_LABEL[sc.event_type]}</span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const cam = nameById[String(c.camera_id)];
                  const online = cam?.status === "online";
                  const ev = c.events || {};
                  return (
                    <tr key={c.camera_id} className="border-b border-card-border last:border-0 hover:bg-hover transition">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`h-2 w-2 rounded-full shrink-0 ${online ? "bg-green-500" : cam?.status === "error" ? "bg-red-500" : "bg-slate-500"}`} />
                          <span className="text-foreground truncate">{c.camera_name || "—"}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <span className="inline-flex items-center gap-1 text-green-500 font-medium">
                          <Icon icon="heroicons-solid:user-group" className="text-[11px]" />{c.live_count ?? 0}
                        </span>
                      </td>
                      {countingOn && <>
                        <td className="px-3 py-2.5 text-right tabular-nums text-green-500">{c.in_count ?? 0}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-red-400">{c.out_count ?? 0}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-medium text-foreground">{c.net ?? 0}</td>
                      </>}
                      {licensedTypes.map((t) => {
                        const n = ev[t] || 0;
                        return (
                          <td key={t} className="px-3 py-2.5 text-right tabular-nums">
                            <span style={n ? { color: META[t].color } : undefined} className={n ? "font-medium" : "text-muted"}>{n}</span>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
