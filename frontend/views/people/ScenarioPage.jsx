"use client";

// One license-gated scenario page (Crowd / People Counting / Loitering / Intrusion),
// parameterised by module id. Everything it shows comes from that scenario's OWN
// endpoints — a client licensed for a single scenario sees only this page and only
// this scenario's data:
//   GET /modules/<id>/summary   -> headline stats (In/Out/Net for directional counting,
//                                   otherwise a total + per-camera mini table)
//   GET /modules/<id>/events    -> filterable, paginated events table + detail modal
//   DELETE /modules/<id>/events/{id}
// If the id isn't in the license, a graceful "not available" panel is shown instead.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Badge, Button, ConfirmDialog, Input, Modal, PageHeader, Select, Spinner } from "@/web/kit";
import { api, apiError, fileUrl } from "@/web/api";

import { EVENT_BADGE, EVENT_COLOR, EVENT_LABEL, fmt } from "./shared";
import { useFeatures } from "./useFeatures";
import CountingChart from "./CountingChart";

const PAGE = 25;

// ── Reusable snapshot bits (ported from the old unified EventsTab) ─────────────

// The stored snapshot is the FULL frame; the person is cropped from it on the fly
// using the event's (native-pixel) bbox — so we never store/serve the same crop
// twice. Draws the padded bbox region of the frame onto a canvas.
function PersonCrop({ url, bbox, className = "h-10 w-16", icon = "heroicons-outline:user", fit = "cover" }) {
  const ref = useRef(null);
  const fitCls = fit === "contain" ? "object-contain" : "object-cover";
  const has = !!url && Array.isArray(bbox) && bbox.length === 4;
  useEffect(() => {
    if (!has) return;
    const canvas = ref.current;
    if (!canvas) return;
    const img = new window.Image();
    // NOTE: no crossOrigin — the snapshot is served cross-origin (RustFS :9000) with
    // no CORS headers, so crossOrigin="anonymous" would FAIL the load and leave the
    // canvas blank. We only DRAW + display the crop (never read pixels back), so a
    // "tainted" canvas is fine — it renders normally.
    img.onload = () => {
      const nw = img.naturalWidth, nh = img.naturalHeight;
      let [x1, y1, x2, y2] = bbox.map(Number);
      // Scenario events store the person box NORMALISED (0..1); scale it to the
      // snapshot's pixel space so we crop the right region (not a sub-pixel dot).
      if (x2 <= 1.5 && y2 <= 1.5) { x1 *= nw; x2 *= nw; y1 *= nh; y2 *= nh; }
      if (!(x2 > x1 && y2 > y1) || x2 > nw + 4 || y2 > nh + 4) {
        canvas.width = nw; canvas.height = nh;
        try { canvas.getContext("2d").drawImage(img, 0, 0); } catch { /* noop */ }
        return;
      }
      const bw = Math.max(1, x2 - x1), bh = Math.max(1, y2 - y1), pad = 0.15;
      x1 = Math.max(0, x1 - bw * pad); y1 = Math.max(0, y1 - bh * pad);
      x2 = Math.min(nw, x2 + bw * pad); y2 = Math.min(nh, y2 + bh * pad);
      const cw = Math.max(1, x2 - x1), ch = Math.max(1, y2 - y1);
      canvas.width = cw; canvas.height = ch;
      try { canvas.getContext("2d").drawImage(img, x1, y1, cw, ch, 0, 0, cw, ch); } catch { /* noop */ }
    };
    img.src = fileUrl(url);
  }, [url, has, JSON.stringify(bbox)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`${className} rounded bg-black/40 border border-card-border overflow-hidden flex items-center justify-center shrink-0`}>
      {has ? (
        <canvas ref={ref} className={`h-full w-full ${fitCls}`} />
      ) : url ? (
        // No person box (e.g. a crowd count event) — show the full frame thumbnail.
        <img src={fileUrl(url)} alt="" loading="lazy" className={`h-full w-full ${fitCls}`} />
      ) : (
        <Icon icon={icon} className="text-muted" />
      )}
    </div>
  );
}

// Full-frame snapshot with the detection box overlaid.
function SnapshotWithBox({ url, bbox }) {
  const [dims, setDims] = useState(null);
  if (!url) return <Icon icon="heroicons-outline:photo" className="text-4xl text-muted" />;
  let box = Array.isArray(bbox) && bbox.length === 4 ? bbox.map(Number) : null;
  // Normalised (0..1) box → scale to the snapshot's pixel space for the overlay.
  if (box && dims && box[2] <= 1.5 && box[3] <= 1.5) {
    box = [box[0] * dims.w, box[1] * dims.h, box[2] * dims.w, box[3] * dims.h];
  }
  return (
    <div className="relative h-full w-full">
      <img src={fileUrl(url)} alt="" className="h-full w-full object-contain"
        onLoad={(e) => setDims({ w: e.target.naturalWidth, h: e.target.naturalHeight })} />
      {dims && box && (
        <svg viewBox={`0 0 ${dims.w} ${dims.h}`} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full pointer-events-none">
          <rect x={box[0]} y={box[1]} width={box[2] - box[0]} height={box[3] - box[1]}
            fill="none" stroke="#22c55e" strokeWidth={Math.max(2, dims.w / 320)} />
        </svg>
      )}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <>
      <dt className="text-[10px] uppercase tracking-wider text-muted self-center">{label}</dt>
      <dd className="min-w-0 text-foreground break-words">{children}</dd>
    </>
  );
}

// One big headline stat in the summary strip.
function BigStat({ icon, color, label, value, loading }) {
  return (
    <div className="flex-1 min-w-0 text-center">
      <div className={`flex items-center justify-center gap-1.5 text-[11px] uppercase tracking-wider ${color}`}>
        {icon && <Icon icon={icon} className="text-sm" />}{label}
      </div>
      {loading
        ? <div className="mx-auto mt-1 h-8 w-14 rounded bg-hover animate-pulse" />
        : <div className="mt-0.5 text-3xl font-semibold text-foreground tabular-nums">{value ?? "—"}</div>}
    </div>
  );
}

// ── Summary strip ─────────────────────────────────────────────────────────────
function SummaryStrip({ meta, summary, loading, color }) {
  const totals = summary?.totals || {};
  const cameras = summary?.cameras || [];
  const directional = !!meta.directional;
  const activeCams = cameras.filter((c) => (c.count || 0) > 0 || (c.in_count || 0) > 0 || (c.out_count || 0) > 0);

  return (
    <div className="rounded-xl border border-card-border bg-card p-4" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="flex items-center gap-2 mb-4">
        <Icon icon={meta.icon} style={{ color }} />
        <h2 className="text-sm font-semibold text-foreground">Last 24 hours</h2>
        <span className="ml-auto text-[11px] text-muted">{summary?.cameras?.length ?? 0} camera{(summary?.cameras?.length ?? 0) === 1 ? "" : "s"}</span>
      </div>

      {directional ? (
        <div className="flex items-center justify-between gap-2">
          <BigStat icon="heroicons-outline:arrow-right-on-rectangle" color="text-green-500" label="In" value={totals.in} loading={loading} />
          <div className="h-10 w-px bg-card-border shrink-0" />
          <BigStat icon="heroicons-outline:arrow-left-on-rectangle" color="text-red-400" label="Out" value={totals.out} loading={loading} />
          <div className="h-10 w-px bg-card-border shrink-0" />
          <BigStat icon="heroicons-outline:scale" color="text-indigo-400" label="Net" value={totals.net} loading={loading} />
          <div className="h-10 w-px bg-card-border shrink-0" />
          <BigStat icon="heroicons-outline:bell-alert" color="text-muted" label="Crossings" value={totals.count} loading={loading} />
        </div>
      ) : (
        <div className="flex items-center gap-6">
          <BigStat icon={meta.icon} color="text-muted" label={`${EVENT_LABEL[meta.event_type] || meta.label} events`} value={totals.count} loading={loading} />
        </div>
      )}

      {/* Per-camera mini table */}
      {!loading && activeCams.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-muted border-b border-card-border">
                <th className="px-2 py-1.5 font-medium">Camera</th>
                {directional ? (
                  <>
                    <th className="px-2 py-1.5 font-medium text-right">In</th>
                    <th className="px-2 py-1.5 font-medium text-right">Out</th>
                    <th className="px-2 py-1.5 font-medium text-right">Net</th>
                  </>
                ) : (
                  <th className="px-2 py-1.5 font-medium text-right">Events</th>
                )}
              </tr>
            </thead>
            <tbody>
              {activeCams.map((c) => (
                <tr key={c.camera_id} className="border-b border-card-border/60 last:border-0">
                  <td className="px-2 py-1.5 text-foreground truncate">{c.camera_name || "—"}</td>
                  {directional ? (
                    <>
                      <td className="px-2 py-1.5 text-right tabular-nums text-green-500">{c.in_count ?? 0}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-red-400">{c.out_count ?? 0}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-medium text-foreground">{c.net ?? 0}</td>
                    </>
                  ) : (
                    <td className="px-2 py-1.5 text-right tabular-nums font-medium" style={{ color }}>{c.count ?? 0}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Not-licensed panel ────────────────────────────────────────────────────────
function NotLicensed({ meta }) {
  return (
    <div className="space-y-6">
      <PageHeader title={meta.label} subtitle="Scenario page" />
      <div className="rounded-xl border border-dashed border-card-border bg-card flex flex-col items-center justify-center py-20 text-center px-6">
        <Icon icon="heroicons-outline:lock-closed" className="text-4xl text-muted mb-3" />
        <p className="text-sm text-foreground font-medium">Not available on your license</p>
        <p className="text-xs text-muted mt-1 max-w-sm">
          The {meta.label} scenario isn’t included in your current plan. Contact your administrator to add it.
        </p>
      </div>
    </div>
  );
}

// ── Scenario page ─────────────────────────────────────────────────────────────
export default function ScenarioPage({ moduleId }) {
  const qc = useQueryClient();
  const { byId, isLicensed, isLoading: featLoading } = useFeatures();
  const meta = byId[moduleId];

  const [page, setPage] = useState(0);
  const [camera, setCamera] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [detail, setDetail] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const licensed = isLicensed(moduleId);

  const cams = useQuery({
    queryKey: ["people-cameras"],
    queryFn: () => api.get("/people/cameras").then((r) => r.data),
    enabled: licensed,
  });

  const summaryQ = useQuery({
    queryKey: ["module-summary", moduleId],
    queryFn: () => api.get(`/modules/${moduleId}/summary`, { params: { since_hours: 24 } }).then((r) => r.data),
    enabled: licensed,
    refetchInterval: 10000,
  });

  const params = useMemo(() => {
    const p = { limit: PAGE, offset: page * PAGE };
    if (camera) p.camera_id = camera;
    if (since) p.since = new Date(since).toISOString();
    if (until) p.until = new Date(until).toISOString();
    return p;
  }, [page, camera, since, until]);

  const events = useQuery({
    queryKey: ["module-events", moduleId, params],
    queryFn: () => api.get(`/modules/${moduleId}/events`, { params }).then((r) => r.data),
    enabled: licensed,
    placeholderData: keepPreviousData,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["module-events", moduleId] });
    qc.invalidateQueries({ queryKey: ["module-summary", moduleId] });
  };
  const remove = useMutation({
    mutationFn: (id) => api.delete(`/modules/${moduleId}/events/${id}`),
    onSuccess: () => { toast.success("Event deleted"); setDetail(null); setConfirm(null); refresh(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const [selected, setSelected] = useState(() => new Set());
  const bulkRemove = useMutation({
    mutationFn: (ids) => api.post(`/modules/${moduleId}/events/bulk-delete`, { ids }),
    onSuccess: (_r, ids) => {
      toast.success(`${ids.length} event${ids.length === 1 ? "" : "s"} deleted`);
      setSelected(new Set()); setConfirm(null); refresh();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // While /features is still resolving we can't know if this scenario is licensed.
  if (featLoading) {
    return <div className="flex justify-center py-24"><Spinner /></div>;
  }
  if (!licensed) {
    return <NotLicensed meta={meta} />;
  }

  const color = meta.color;
  const data = events.data;
  const items = data?.items || [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE));

  const camOpts = [{ value: "", label: "All cameras" }, ...(cams.data || []).map((c) => ({ value: c.id, label: c.name }))];
  const hasFilters = camera || since || until;
  function resetFilters() { setCamera(""); setSince(""); setUntil(""); setPage(0); }

  const badge = (e) => (
    <Badge color={EVENT_COLOR[e.event_type] || "slate"}>{EVENT_BADGE[e.event_type] || EVENT_LABEL[e.event_type] || e.event_type}</Badge>
  );

  // --- bulk selection over the current page ---
  const allOnPageSelected = items.length > 0 && items.every((e) => selected.has(e.id));
  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allOnPageSelected) items.forEach((e) => next.delete(e.id));
    else items.forEach((e) => next.add(e.id));
    return next;
  });
  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const colSpan = (meta.directional ? 7 : 6) + 1;   // +1 for the checkbox column

  return (
    <div className="space-y-5">
      <PageHeader
        title={meta.label}
        subtitle={meta.directional
          ? "Directional in/out people counting — crossings, net occupancy and per-camera tallies."
          : `${EVENT_LABEL[meta.event_type] || meta.label} events across your cameras.`}
      />

      <SummaryStrip meta={meta} summary={summaryQ.data} loading={summaryQ.isLoading} color={color} />

      {/* People Counting leads with a camera-based time-series (In/Out over time) —
          a raw per-crossing log is hard to read, so the chart is the primary view and
          the event table below is a secondary detail log. */}
      {meta.directional && <CountingChart moduleId={moduleId} cameras={cams.data} />}

      {meta.directional && (
        <div className="flex items-center gap-2 pt-1 text-xs uppercase tracking-wider text-muted">
          <Icon icon="heroicons-outline:list-bullet" /> Event log
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-card-border bg-card p-3">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted mr-1"><Icon icon="heroicons-outline:funnel" /> Filters</div>
        <div className="w-44"><Select options={camOpts} value={camera} onChange={(e) => { setCamera(e.target.value); setPage(0); }} placeholder="Camera" /></div>
        <div><span className="block text-[10px] uppercase tracking-wider text-muted mb-0.5">From</span><Input type="datetime-local" value={since} onChange={(e) => { setSince(e.target.value); setPage(0); }} /></div>
        <div><span className="block text-[10px] uppercase tracking-wider text-muted mb-0.5">To</span><Input type="datetime-local" value={until} onChange={(e) => { setUntil(e.target.value); setPage(0); }} /></div>
        {hasFilters && <Button variant="ghost" icon="heroicons-outline:x-mark" onClick={resetFilters}>Clear</Button>}
        {selected.size > 0 && (
          <Button variant="danger" icon="heroicons-outline:trash"
            onClick={() => setConfirm({
              title: `Delete ${selected.size} event${selected.size === 1 ? "" : "s"}?`,
              message: "This permanently removes the selected events and their snapshots.",
              confirmLabel: "Delete", onConfirm: () => bulkRemove.mutate([...selected]),
            })}>
            Delete {selected.size} selected
          </Button>
        )}
        <div className="ml-auto text-xs text-muted self-center flex items-center gap-2">
          {total} event{total === 1 ? "" : "s"}
          {events.isFetching && <Spinner className="h-3 w-3" />}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-card-border bg-card overflow-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted border-b border-card-border">
              <th className="px-3 py-2.5 w-9">
                <input type="checkbox" checked={allOnPageSelected} onChange={toggleAll}
                  className="h-3.5 w-3.5 accent-red-500 align-middle cursor-pointer" title="Select all on this page" />
              </th>
              <th className="px-3 py-2.5 font-medium">Time</th>
              <th className="px-3 py-2.5 font-medium">Camera</th>
              <th className="px-3 py-2.5 font-medium">Type</th>
              {meta.directional && <th className="px-3 py-2.5 font-medium">Direction</th>}
              <th className="px-3 py-2.5 font-medium">Details</th>
              <th className="px-3 py-2.5 font-medium">Snapshot</th>
              <th className="px-3 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {events.isLoading ? (
              <tr><td colSpan={colSpan} className="px-3 py-16 text-center"><Spinner /></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={colSpan} className="px-3 py-16 text-center">
                <Icon icon="heroicons-outline:bell-slash" className="text-4xl mx-auto text-muted mb-2" />
                <p className="text-sm text-foreground">No {meta.label.toLowerCase()} events</p>
                <p className="text-xs text-muted mt-1">{hasFilters ? "Try widening your filters." : "Events appear here as this scenario triggers."}</p>
              </td></tr>
            ) : (
              items.map((e) => (
                <tr key={e.id} onClick={() => setDetail(e)} className={`border-b border-card-border last:border-0 hover:bg-hover transition cursor-pointer ${selected.has(e.id) ? "bg-red-500/5" : ""}`}>
                  <td className="px-3 py-2" onClick={(ev) => ev.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleOne(e.id)}
                      className="h-3.5 w-3.5 accent-red-500 align-middle cursor-pointer" />
                  </td>
                  <td className="px-3 py-2 text-muted whitespace-nowrap">{fmt(e.triggered_at)}</td>
                  <td className="px-3 py-2 text-muted">{e.camera_name || "—"}</td>
                  <td className="px-3 py-2">{badge(e)}</td>
                  {meta.directional && (
                    <td className="px-3 py-2">
                      {e.attributes?.direction
                        ? <Badge color={e.attributes.direction === "in" ? "green" : "amber"}>{e.attributes.direction === "in" ? "IN ↓" : "OUT ↑"}</Badge>
                        : <span className="text-muted">—</span>}
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate max-w-[180px]">{e.title || EVENT_LABEL[e.event_type] || "—"}</span>
                      {e.count != null && <span className="text-xs tabular-nums" style={{ color }}>×{e.count}</span>}
                    </div>
                    {e.zone_name && <div className="text-[11px] text-muted truncate max-w-[180px]">{e.zone_name}</div>}
                  </td>
                  <td className="px-3 py-2"><PersonCrop url={e.snapshot_url} bbox={e.bbox} /></td>
                  <td className="px-3 py-2 text-right whitespace-nowrap" onClick={(ev) => ev.stopPropagation()}>
                    <button title="Delete" className="p-1.5 text-red-500 hover:text-red-400" onClick={() => setConfirm({ title: "Delete this event?", message: "This removes the event and its snapshot.", confirmLabel: "Delete", onConfirm: () => remove.mutate(e.id) })}><Icon icon="heroicons-outline:trash" /></button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > PAGE && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted">Page {page + 1} / {totalPages}</span>
          <Button variant="secondary" icon="heroicons-outline:chevron-left" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} />
          <Button variant="secondary" icon="heroicons-outline:chevron-right" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} />
        </div>
      )}

      {/* Detail modal */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title="Event details" wide
        footer={detail && <>
          <Button variant="ghost" icon="heroicons-outline:trash" className="text-red-500" onClick={() => setConfirm({ title: "Delete this event?", message: "This removes the event and its snapshot.", confirmLabel: "Delete", onConfirm: () => remove.mutate(detail.id) })}>Delete</Button>
          <div className="flex-1" />
        </>}>
        {detail && (
          <div className="grid md:grid-cols-5 gap-4 items-stretch">
            <div className="md:col-span-3 flex flex-col">
              <div className="text-[10px] uppercase tracking-wider text-muted mb-1.5">Snapshot</div>
              <div className="flex-1 min-h-[240px] rounded-lg bg-black/40 border border-card-border overflow-hidden flex items-center justify-center">
                <SnapshotWithBox url={detail.snapshot_url} bbox={detail.bbox} />
              </div>
            </div>
            <div className="md:col-span-2 flex flex-col gap-3">
              {/* "Detected person" crop only for single-person events (intrusion /
                  loitering / line-crossing). Crowd is a count — no single box — so we
                  skip it (the full-frame snapshot on the left tells the story). */}
              {Array.isArray(detail.bbox) && detail.bbox.length === 4 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted mb-1.5">Detected person</div>
                  <PersonCrop url={detail.snapshot_url} bbox={detail.bbox} className="aspect-[3/4] w-full" icon="heroicons-outline:user" fit="contain" />
                </div>
              )}
              <dl className="grid grid-cols-[84px_1fr] gap-x-3 gap-y-2 text-sm items-center">
                <Row label="Type">{badge(detail)}</Row>
                {detail.attributes?.direction && (
                  <Row label="Direction">
                    <Badge color={detail.attributes.direction === "in" ? "green" : "amber"}>
                      {detail.attributes.direction === "in" ? "IN ↓" : "OUT ↑"}
                    </Badge>
                  </Row>
                )}
                {detail.title && <Row label="Title">{detail.title}</Row>}
                {detail.count != null && <Row label="Count">{detail.count}</Row>}
                {detail.attributes?.dwell_seconds != null && <Row label="Dwell">{detail.attributes.dwell_seconds}s</Row>}
                {detail.zone_name && <Row label="Zone">{detail.zone_name}</Row>}
                {detail.severity && <Row label="Severity"><Badge color={detail.severity === "high" ? "red" : detail.severity === "medium" ? "amber" : "slate"}>{detail.severity}</Badge></Row>}
                <Row label="Camera">{detail.camera_name || "—"}</Row>
                {detail.track_id != null && <Row label="Track">{detail.track_id}</Row>}
                <Row label="Time">{fmt(detail.triggered_at)}</Row>
              </dl>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
