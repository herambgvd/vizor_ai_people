"use client";

// Camera-based time-series for People Counting: instead of a raw per-crossing log,
// plot IN vs OUT per time bucket (hourly ≤48h, else daily). Diverging bars — IN
// rises above the baseline (green), OUT drops below it (amber) — so DIRECTION is
// encoded by position (up/down), not colour alone (CVD-safe), with a legend + hover
// tooltip. A running occupancy figure is shown alongside. Pure inline SVG, no dep.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { api } from "@/web/api";
import { Select, Spinner } from "@/web/kit";

const IN_COLOR = "#22c55e";   // entries
const OUT_COLOR = "#f59e0b";  // exits
const RANGES = [
  { value: "24", label: "Last 24 hours" },
  { value: "168", label: "Last 7 days" },
  { value: "720", label: "Last 30 days" },
];

const W = 1000, H = 260, PADX = 40, PADTOP = 18, PADBOT = 34;
const PLOT_W = W - PADX * 2, PLOT_H = H - PADTOP - PADBOT;
const MIDY = PADTOP + PLOT_H / 2;

function bucketLabel(iso, bucketHours) {
  const d = new Date(iso);
  if (bucketHours >= 24) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleTimeString([], { hour: "numeric" });
}

export default function CountingChart({ moduleId, cameras }) {
  const [range, setRange] = useState("24");
  const [camera, setCamera] = useState("");
  const [hover, setHover] = useState(null); // {i, x}

  const q = useQuery({
    queryKey: ["module-timeseries", moduleId, range, camera],
    queryFn: () =>
      api.get(`/modules/${moduleId}/timeseries`, {
        params: { since_hours: Number(range), ...(camera ? { camera_id: camera } : {}) },
      }).then((r) => r.data),
    refetchInterval: 15000,
  });

  const buckets = q.data?.buckets || [];
  const bucketHours = q.data?.bucket_hours || 1;
  const peak = useMemo(
    () => Math.max(1, ...buckets.map((b) => Math.max(b.in || 0, b.out || 0))),
    [buckets],
  );
  const totals = useMemo(
    () => buckets.reduce((a, b) => ({ in: a.in + (b.in || 0), out: a.out + (b.out || 0) }), { in: 0, out: 0 }),
    [buckets],
  );
  const netFlow = totals.in - totals.out;   // signed net flow over the window (not absolute occupancy)

  const n = buckets.length || 1;
  const step = PLOT_W / n;
  const barW = Math.min(26, Math.max(3, step * 0.55));
  const yUp = (v) => (v / peak) * (PLOT_H / 2 - 4);   // bar height above/below mid
  const labelEvery = Math.ceil(n / 12);

  const camOpts = [{ value: "", label: "All cameras" }, ...(cameras || []).map((c) => ({ value: c.id, label: c.name }))];

  return (
    <section className="rounded-xl border border-card-border bg-card p-4">
      {/* header + controls (one row above the chart) */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Icon icon="heroicons-outline:chart-bar" className="text-lg text-muted" />
          <h3 className="text-sm font-semibold text-foreground">In / Out over time</h3>
        </div>
        {/* legend — always present for 2 series */}
        <div className="flex items-center gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1"><span className="h-2 w-2.5 rounded-sm" style={{ background: IN_COLOR }} /> In ↓</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2.5 rounded-sm" style={{ background: OUT_COLOR }} /> Out ↑</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="w-40"><Select options={camOpts} value={camera} onChange={(e) => setCamera(e.target.value)} /></div>
          <div className="w-40"><Select options={RANGES} value={range} onChange={(e) => setRange(e.target.value)} /></div>
        </div>
      </div>

      {/* quick figures */}
      <div className="flex flex-wrap gap-x-8 gap-y-1 mb-3 text-sm">
        <span className="text-muted">Entered <b className="text-foreground tabular-nums ml-1" style={{ color: IN_COLOR }}>{totals.in}</b></span>
        <span className="text-muted">Exited <b className="text-foreground tabular-nums ml-1" style={{ color: OUT_COLOR }}>{totals.out}</b></span>
        <span className="text-muted">Net flow <b className="text-foreground tabular-nums ml-1">{netFlow > 0 ? "+" : ""}{netFlow}</b></span>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : totals.in + totals.out === 0 ? (
        <div className="py-16 text-center text-muted text-sm">
          <Icon icon="heroicons-outline:chart-bar" className="text-3xl mx-auto mb-2 opacity-60" />
          No crossings in this period.
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }} preserveAspectRatio="none">
            {/* baseline + faint gridlines */}
            <line x1={PADX} y1={MIDY} x2={W - PADX} y2={MIDY} stroke="currentColor" className="text-card-border" strokeWidth="1" />
            {[0.5, 1].map((f) => (
              <g key={f} className="text-card-border">
                <line x1={PADX} y1={MIDY - f * (PLOT_H / 2 - 4)} x2={W - PADX} y2={MIDY - f * (PLOT_H / 2 - 4)} stroke="currentColor" strokeWidth="0.5" strokeDasharray="3 4" opacity="0.5" />
                <line x1={PADX} y1={MIDY + f * (PLOT_H / 2 - 4)} x2={W - PADX} y2={MIDY + f * (PLOT_H / 2 - 4)} stroke="currentColor" strokeWidth="0.5" strokeDasharray="3 4" opacity="0.5" />
              </g>
            ))}
            {/* y ticks (peak up = in, peak down = out) */}
            <text x={PADX - 6} y={MIDY - (PLOT_H / 2 - 4) + 4} textAnchor="end" className="fill-current text-muted" fontSize="11">{peak}</text>
            <text x={PADX - 6} y={MIDY + (PLOT_H / 2 - 4) + 4} textAnchor="end" className="fill-current text-muted" fontSize="11">{peak}</text>

            {buckets.map((b, i) => {
              const cx = PADX + step * i + step / 2;
              const inH = yUp(b.in || 0), outH = yUp(b.out || 0);
              const r = Math.min(4, barW / 2);
              return (
                <g key={i}>
                  {(b.in || 0) > 0 && <rect x={cx - barW / 2} y={MIDY - inH} width={barW} height={inH} rx={r} fill={IN_COLOR} />}
                  {(b.out || 0) > 0 && <rect x={cx - barW / 2} y={MIDY} width={barW} height={outH} rx={r} fill={OUT_COLOR} />}
                  {/* hit target for hover (full column) */}
                  <rect x={PADX + step * i} y={PADTOP} width={step} height={PLOT_H} fill="transparent"
                    onMouseEnter={() => setHover({ i, x: (cx / W) * 100 })} onMouseLeave={() => setHover(null)} />
                  {i % labelEvery === 0 && (
                    <text x={cx} y={H - 12} textAnchor="middle" className="fill-current text-muted" fontSize="11">{bucketLabel(b.start, bucketHours)}</text>
                  )}
                </g>
              );
            })}
            {hover && (
              <line x1={PADX + step * hover.i + step / 2} y1={PADTOP} x2={PADX + step * hover.i + step / 2} y2={PADTOP + PLOT_H}
                stroke="currentColor" className="text-muted" strokeWidth="1" opacity="0.4" />
            )}
          </svg>

          {/* tooltip */}
          {hover && buckets[hover.i] && (
            <div className="pointer-events-none absolute -translate-x-1/2 -top-1 rounded-md border border-card-border bg-card px-2.5 py-1.5 text-xs shadow-lg"
              style={{ left: `${hover.x}%` }}>
              <div className="text-muted mb-0.5">{new Date(buckets[hover.i].start).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", ...(bucketHours < 24 ? { minute: "2-digit" } : {}) })}</div>
              <div className="flex gap-3 tabular-nums">
                <span style={{ color: IN_COLOR }}>In {buckets[hover.i].in || 0}</span>
                <span style={{ color: OUT_COLOR }}>Out {buckets[hover.i].out || 0}</span>
                <span className="text-foreground">Net {(buckets[hover.i].in || 0) - (buckets[hover.i].out || 0)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
