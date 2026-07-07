"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge, Button, ConfirmDialog, EmptyState, Input, Modal, Select, Spinner, Toggle } from "@/web/kit";
import { api, apiError, fileUrl } from "@/web/api";

import { CAM_ANALYZE_RES, CAM_HWACCEL, CAM_STATUS_COLOR, SCENARIOS, lineSeg } from "./shared";
import { useFeatures } from "./useFeatures";

const round = (n) => Number(n.toFixed(4));
const arr = (v) => (Array.isArray(v) ? v : []);

// Normalise a click/drag position to a 0..1 [x,y] over the reference frame.
function useNormPos(wrapRef) {
  return (e) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return null;
    return [
      round(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))),
      round(Math.min(1, Math.max(0, (e.clientY - box.top) / box.height))),
    ];
  };
}

// ── Zone editor ───────────────────────────────────────────────────────────────
// Polygon over the camera's reference snapshot, stored as normalised (0..1)
// [[x,y],...] so it is resolution-independent. Click to add a point, drag a
// corner to move it, Undo/Clear from the toolbar. `color` tints the scenario.
function ZoneEditor({ value, onChange, bg, color = "#22c55e" }) {
  const points = arr(value);
  const wrapRef = useRef(null);
  const toNorm = useNormPos(wrapRef);
  const [dragIdx, setDragIdx] = useState(null);

  const addPoint = (e) => { if (dragIdx === null) { const p = toNorm(e); if (p) onChange([...points, p]); } };

  useEffect(() => {
    if (dragIdx === null) return;
    const move = (e) => { const p = toNorm(e); if (p) onChange(points.map((q, i) => (i === dragIdx ? p : q))); };
    const up = () => setDragIdx(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [dragIdx, points, onChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const poly = points.map((p) => `${p[0] * 100},${p[1] * 100}`).join(" ");
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-muted">Zone — {points.length} point{points.length === 1 ? "" : "s"}</span>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => onChange(points.slice(0, -1))} disabled={!points.length}
            className="text-xs px-2 py-1 rounded border border-card-border text-muted hover:text-foreground disabled:opacity-40">Undo</button>
          <button type="button" onClick={() => onChange([])} disabled={!points.length}
            className="text-xs px-2 py-1 rounded border border-card-border text-red-500 hover:text-red-400 disabled:opacity-40">Clear</button>
        </div>
      </div>
      <div ref={wrapRef} onClick={addPoint}
        className="relative aspect-video w-full overflow-hidden rounded-lg border border-card-border bg-black/40 cursor-crosshair select-none"
        style={bg ? { backgroundImage: `url(${bg})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {points.length > 1 && <polygon points={poly} fill={`${color}2e`} stroke={color} strokeWidth="0.4" />}
          {points.map((p, i) => (
            <circle key={i} cx={p[0] * 100} cy={p[1] * 100} r="1.4" fill={color} stroke="#fff" strokeWidth="0.3"
              className="cursor-move" onMouseDown={(e) => { e.stopPropagation(); setDragIdx(i); }} onClick={(e) => e.stopPropagation()} />
          ))}
        </svg>
        {!bg && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-4 text-center">
            <span className="text-xs text-muted">Test the camera to capture a reference frame, then click to draw the zone.</span>
          </div>
        )}
      </div>
      <p className="text-xs text-muted mt-1.5">Click to add a corner · drag a corner to move · empty = whole frame</p>
    </div>
  );
}

// ── Line editor ───────────────────────────────────────────────────────────────
// A virtual counting line = exactly two normalised points. Click to place the two
// ends (replaces the oldest once both exist), drag an end to fine-tune.
function LineEditor({ value, onChange, bg, color = "#3b82f6" }) {
  const pts = arr(value).slice(0, 2);
  const wrapRef = useRef(null);
  const toNorm = useNormPos(wrapRef);
  const [dragIdx, setDragIdx] = useState(null);
  // Straight segment between the two ends, in the same 0..100 space as the point
  // handles below (and the Live overlay). null while fewer than two ends exist.
  const seg = lineSeg(pts);

  const place = (e) => {
    if (dragIdx !== null) return;
    const p = toNorm(e);
    if (!p) return;
    if (pts.length < 2) onChange([...pts, p]);
    else onChange([pts[1], p]); // roll: keep the most recent end, add the new one
  };

  useEffect(() => {
    if (dragIdx === null) return;
    const move = (e) => { const p = toNorm(e); if (p) onChange(pts.map((q, i) => (i === dragIdx ? p : q))); };
    const up = () => setDragIdx(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [dragIdx, pts, onChange]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-muted">Line — {pts.length}/2 points</span>
        <button type="button" onClick={() => onChange([])} disabled={!pts.length}
          className="text-xs px-2 py-1 rounded border border-card-border text-red-500 hover:text-red-400 disabled:opacity-40">Clear</button>
      </div>
      <div ref={wrapRef} onClick={place}
        className="relative aspect-video w-full overflow-hidden rounded-lg border border-card-border bg-black/40 cursor-crosshair select-none"
        style={bg ? { backgroundImage: `url(${bg})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {seg && <line x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} stroke={color} strokeWidth="0.6" vectorEffect="non-scaling-stroke" />}
          {pts.map((p, i) => (
            <circle key={i} cx={p[0] * 100} cy={p[1] * 100} r="1.6" fill={color} stroke="#fff" strokeWidth="0.3"
              className="cursor-move" onMouseDown={(e) => { e.stopPropagation(); setDragIdx(i); }} onClick={(e) => e.stopPropagation()} />
          ))}
        </svg>
        {!bg && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-4 text-center">
            <span className="text-xs text-muted">Test the camera to capture a reference frame, then click two points to draw the line.</span>
          </div>
        )}
      </div>
      <p className="text-xs text-muted mt-1.5">Click to place the two ends · drag an end to adjust · people crossing are counted</p>
    </div>
  );
}

function scenariosOf(s) {
  s = s || {};
  return {
    crowd: { enabled: !!s.crowd?.enabled, zone: arr(s.crowd?.zone), threshold: s.crowd?.threshold ?? 5 },
    counting: { enabled: !!s.counting?.enabled, line: arr(s.counting?.line) },
    loitering: { enabled: !!s.loitering?.enabled, zone: arr(s.loitering?.zone), threshold_seconds: s.loitering?.threshold_seconds ?? 30 },
    intrusion: { enabled: !!s.intrusion?.enabled, zone: arr(s.intrusion?.zone) },
  };
}

function draftOf(c) {
  return {
    name: c.name || "", rtsp_url: c.rtsp_url || "", location: c.location || "", zone: c.zone || "",
    hw_accel: c.hw_accel || "none",
    analytics_enabled: !!c.analytics_enabled, enabled: !!c.enabled,
    person_conf: c.person_conf ?? 0.4,
    min_box_px: c.min_box_px ?? 32,
    alert_suppress_seconds: c.alert_suppress_seconds ?? 60,
    fps: c.fps ?? 10,
    analyze_width: c.analyze_width ?? 0,
    scenarios: scenariosOf(c.scenarios),
  };
}

// Small labelled toggle row used inside the config groups.
function ToggleRow({ title, desc, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-card-border px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {desc && <div className="text-xs text-muted mt-0.5">{desc}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

// One scenario block: header toggle + (when on) its zone/line editor and params.
function ScenarioCard({ meta, cfg, onChange, bg }) {
  const on = !!cfg.enabled;
  const set = (patch) => onChange({ ...cfg, ...patch });
  return (
    <div className="rounded-lg border border-card-border overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-hover/40">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon icon={meta.icon} className="text-lg shrink-0" style={{ color: meta.color }} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{meta.label}</div>
            <div className="text-xs text-muted truncate">{meta.desc}</div>
          </div>
        </div>
        <Toggle checked={on} onChange={(v) => set({ enabled: v })} />
      </div>
      {on && (
        <div className="p-3 space-y-3 border-t border-card-border">
          {meta.shape === "zone"
            ? <ZoneEditor value={cfg.zone} onChange={(zone) => set({ zone })} bg={bg} color={meta.color} />
            : <LineEditor value={cfg.line} onChange={(line) => set({ line })} bg={bg} color={meta.color} />}
          {meta.key === "crowd" && (
            <Input label="People threshold" type="number" step="1" min="1" max="200" value={cfg.threshold}
              onChange={(e) => set({ threshold: e.target.value })}
              hint="Raise an alert when more than this many people are inside the zone at once." />
          )}
          {meta.key === "loitering" && (
            <Input label="Dwell time (seconds)" type="number" step="5" min="5" max="3600" value={cfg.threshold_seconds}
              onChange={(e) => set({ threshold_seconds: e.target.value })}
              hint="Raise an alert when a person stays in the zone longer than this." />
          )}
        </div>
      )}
    </div>
  );
}

// ── Right pane: the selected camera's configuration ───────────────────────────
function CameraConfigPanel({ camera, qc, onDeleted }) {
  const { isLicensed } = useFeatures();
  // Only LICENSED scenarios are configurable — an unlicensed scenario's editor is hidden.
  const visibleScenarios = SCENARIOS.filter((m) => isLicensed(m.key));
  const [draft, setDraft] = useState(() => draftOf(camera));
  const [confirmDel, setConfirmDel] = useState(false);
  // Snapshot (JSON) of the SERVER state the current draft was last seeded from.
  // Lets us tell a pristine pane (safe to adopt fresh server values) apart from one
  // with unsaved edits — so background polling never clobbers an in-flight edit, yet
  // an idle pane always tracks the server's real value (e.g. analytics_enabled).
  const seededRef = useRef(JSON.stringify(draftOf(camera)));
  const reseed = (c) => { const s = draftOf(c); seededRef.current = JSON.stringify(s); setDraft(s); };

  // Re-seed from the server when a DIFFERENT camera is selected OR the server value
  // changes while the pane is pristine. This guarantees the draft never holds a
  // STALE `analytics_enabled` (or any field) that a later save would wrongly persist:
  // if the DB has analytics ON, a pristine pane adopts ON before the operator saves.
  useEffect(() => {
    const server = draftOf(camera);
    const serverStr = JSON.stringify(server);
    if (serverStr === seededRef.current) return; // server unchanged since last seed
    setDraft((cur) => {
      const pristine = JSON.stringify(cur) === seededRef.current;
      seededRef.current = serverStr;
      return pristine ? server : cur; // keep unsaved edits; otherwise track the server
    });
  }, [camera]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = useMutation({
    mutationFn: (b) => api.put(`/people/cameras/${camera.id}`, b),
    // Re-seed the draft from the SERVER's response so the pane mirrors exactly what
    // was persisted — the toggle can never drift to a stale value a later save reverts.
    onSuccess: (r) => { toast.success("Camera saved"); if (r?.data) reseed(r.data); qc.invalidateQueries({ queryKey: ["people-cameras"] }); },
    onError: (e) => toast.error(apiError(e)),
  });
  // "Person analytics" is toggled via its OWN immediate PUT — never bundled into a
  // scenario/config save. This is the definitive fix for analytics silently turning
  // off: a config save can't carry a stale analytics_enabled, and the toggle persists
  // the instant it's flipped (re-seeding the draft from the server response).
  const toggleAnalytics = useMutation({
    mutationFn: (v) => api.put(`/people/cameras/${camera.id}`, { analytics_enabled: v }),
    onSuccess: (r) => { if (r?.data) reseed(r.data); qc.invalidateQueries({ queryKey: ["people-cameras"] }); toast.success(r?.data?.analytics_enabled ? "Analytics on" : "Analytics off"); },
    onError: (e) => toast.error(apiError(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/people/cameras/${camera.id}`),
    onSuccess: () => { toast.success("Camera deleted"); qc.invalidateQueries({ queryKey: ["people-cameras"] }); onDeleted(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post(`/people/cameras/${camera.id}/test`),
    onSuccess: (r) => { r.data.status === "online" ? toast.success("Camera reachable — frame captured") : toast.error(r.data.last_error || "Camera unreachable"); qc.invalidateQueries({ queryKey: ["people-cameras"] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const setScenario = (key, cfg) => setDraft((d) => ({ ...d, scenarios: { ...d.scenarios, [key]: cfg } }));
  const base = draftOf(camera);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const valid = draft.name.trim() && draft.rtsp_url.trim();
  const RESTART_KEYS = [
    "rtsp_url", "fps", "person_conf", "min_box_px", "alert_suppress_seconds",
    "hw_accel", "analyze_width", "scenarios", "analytics_enabled",
  ];
  const willRestart = draft.analytics_enabled && dirty && RESTART_KEYS.some((k) => JSON.stringify(draft[k]) !== JSON.stringify(base[k]));

  const bg = camera.snapshot_url ? fileUrl(camera.snapshot_url) : null;
  const activeScenarios = visibleScenarios.filter((m) => draft.scenarios[m.key]?.enabled).length;

  function serialiseScenarios() {
    const s = draft.scenarios;
    return {
      crowd: { enabled: !!s.crowd.enabled, zone: arr(s.crowd.zone), threshold: Number(s.crowd.threshold) || 0 },
      counting: { enabled: !!s.counting.enabled, line: arr(s.counting.line).slice(0, 2) },
      loitering: { enabled: !!s.loitering.enabled, zone: arr(s.loitering.zone), threshold_seconds: Number(s.loitering.threshold_seconds) || 0 },
      intrusion: { enabled: !!s.intrusion.enabled, zone: arr(s.intrusion.zone) },
    };
  }

  function save() {
    if (!valid) return;
    patch.mutate({
      name: draft.name.trim(), rtsp_url: draft.rtsp_url.trim(), location: draft.location || null, zone: draft.zone || null,
      hw_accel: draft.hw_accel, enabled: draft.enabled,
      person_conf: Number(draft.person_conf), min_box_px: Number(draft.min_box_px),
      alert_suppress_seconds: Number(draft.alert_suppress_seconds), fps: Number(draft.fps),
      analyze_width: Number(draft.analyze_width),
      scenarios: serialiseScenarios(),
    });
  }

  return (
    <div className="rounded-xl border border-card-border bg-card flex flex-col h-full overflow-hidden">
      {/* header */}
      <div className="flex items-center justify-between gap-3 border-b border-card-border p-4 shrink-0">
        <div className="min-w-0">
          <div className="font-semibold text-foreground truncate">{camera.name}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <Badge color={CAM_STATUS_COLOR[camera.status] || "slate"}>{camera.status}</Badge>
            <Badge color={camera.analytics_enabled ? "green" : "slate"}>{camera.analytics_enabled ? "Analytics on" : "Analytics off"}</Badge>
            {camera.last_error && <span className="text-xs text-red-500 truncate max-w-[240px]" title={camera.last_error}>{camera.last_error}</span>}
          </div>
        </div>
        <Button variant="secondary" icon="heroicons-outline:signal" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? "Testing…" : "Test"}
        </Button>
      </div>

      <div className="p-4 grid grid-cols-1 xl:grid-cols-2 gap-x-6 gap-y-5 flex-1 overflow-y-auto">
        {/* left inner column: settings */}
        <div className="space-y-5">
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Source</h4>
            <Input label="Name" value={draft.name} onChange={(e) => set("name", e.target.value)} />
            <Input label="RTSP URL" value={draft.rtsp_url} onChange={(e) => set("rtsp_url", e.target.value)} placeholder="rtsp://user:pass@host:554/stream" />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Location" value={draft.location} onChange={(e) => set("location", e.target.value)} />
              <Input label="Zone" value={draft.zone} onChange={(e) => set("zone", e.target.value)} />
            </div>
          </section>

          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Analytics</h4>
            <ToggleRow title="Person analytics" desc="Detect and track people, and run the enabled scenarios." checked={draft.analytics_enabled} onChange={(v) => { set("analytics_enabled", v); toggleAnalytics.mutate(v); }} />
          </section>

          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Detection quality</h4>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Person confidence" type="number" step="0.05" min="0.1" max="0.9" value={draft.person_conf} onChange={(e) => set("person_conf", e.target.value)}
                hint="Detector confidence floor. Lower catches far/small people (more false positives)." />
              <Input label="Min person size (px)" type="number" step="4" min="8" max="400" value={draft.min_box_px} onChange={(e) => set("min_box_px", e.target.value)}
                hint="Ignore person boxes smaller than this — filters distant noise." />
            </div>
          </section>

          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Alerting</h4>
            <Input label="Alert cooldown (s)" type="number" step="10" min="0" max="3600" value={draft.alert_suppress_seconds} onChange={(e) => set("alert_suppress_seconds", e.target.value)}
              hint="Minimum gap between repeat alerts for the same scenario / track." />
          </section>

          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Stream</h4>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Analyze FPS" type="number" step="1" min="1" max="15" value={draft.fps} onChange={(e) => set("fps", e.target.value)}
                hint="Frames analysed per second. Higher = smoother tracking, more CPU." />
              <Select label="Decode" options={CAM_HWACCEL} value={draft.hw_accel} onChange={(e) => set("hw_accel", e.target.value)} />
            </div>
            <Select label="Analyze resolution" options={CAM_ANALYZE_RES} value={String(draft.analyze_width)} onChange={(e) => set("analyze_width", Number(e.target.value))} />
            <p className="text-xs text-muted">
              High-resolution cameras are downscaled for analysis to save CPU — with Decode = NVDEC the resize runs on the GPU.
              720p–1080p keeps full accuracy for room-scale views.
            </p>
          </section>

          <div className="flex items-center justify-between rounded-md border border-card-border px-3 py-2.5">
            <div><span className="text-sm font-medium text-foreground">Camera enabled</span><div className="text-xs text-muted">Disable to stop streaming without deleting.</div></div>
            <Toggle checked={draft.enabled} onChange={(v) => set("enabled", v)} />
          </div>
        </div>

        {/* right inner column: scenarios drawn on the reference frame */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Scenarios</h4>
            <span className="text-xs text-muted">{activeScenarios} active</span>
          </div>
          {visibleScenarios.map((meta) => (
            <ScenarioCard key={meta.key} meta={meta} cfg={draft.scenarios[meta.key]} bg={bg}
              onChange={(cfg) => setScenario(meta.key, cfg)} />
          ))}
          {visibleScenarios.length === 0 && (
            <div className="rounded-lg border border-dashed border-card-border px-3 py-6 text-center text-xs text-muted">
              No scenarios are enabled on your license.
            </div>
          )}
          {willRestart && (
            <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              <Icon icon="heroicons-outline:arrow-path" className="mt-0.5 shrink-0" />
              Changing analytics parameters or scenarios restarts this camera's worker (a few seconds of downtime) so the new settings take effect.
            </div>
          )}
        </div>
      </div>

      {/* actions */}
      <div className="flex items-center justify-between border-t border-card-border p-4 shrink-0">
        <Button variant="ghost" className="text-red-500 hover:text-red-400" icon="heroicons-outline:trash" onClick={() => setConfirmDel(true)}>Delete</Button>
        <Button variant="primary" disabled={!dirty || !valid || patch.isPending} onClick={save}>{patch.isPending ? "Saving…" : "Save changes"}</Button>
      </div>

      <ConfirmDialog
        state={confirmDel ? { title: "Delete camera", message: <>Delete <strong>{camera.name}</strong>? This removes the camera and stops its worker.</>, confirmLabel: "Delete camera", onConfirm: () => remove.mutate() } : null}
        onClose={() => setConfirmDel(false)} pending={remove.isPending} />
    </div>
  );
}

// ── Cameras tab: master–detail split ──────────────────────────────────────────
const EMPTY_CREATE = { name: "", rtsp_url: "", location: "" };

export default function CamerasTab() {
  const qc = useQueryClient();
  const [openCreate, setOpenCreate] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");

  // Keep the list fresh so the detail pane's analytics_enabled can't silently go
  // stale against the DB (a pristine pane re-seeds from these fresh values).
  const cams = useQuery({
    queryKey: ["people-cameras"],
    queryFn: () => api.get("/people/cameras").then((r) => r.data),
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });
  const list = cams.data || [];
  const online = list.filter((c) => c.status === "online").length;
  const active = list.filter((c) => c.analytics_enabled).length;

  // Keep a valid selection: default to the first camera; clear if it vanishes.
  useEffect(() => {
    if (!list.length) { if (selectedId) setSelectedId(null); return; }
    if (!list.some((c) => c.id === selectedId)) setSelectedId(list[0].id);
  }, [list, selectedId]);
  const selected = useMemo(() => list.find((c) => c.id === selectedId) || null, [list, selectedId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? list.filter((c) => `${c.name} ${c.location || ""} ${c.zone || ""}`.toLowerCase().includes(q)) : list;
  }, [list, search]);

  const create = useMutation({
    mutationFn: (b) => api.post("/people/cameras", b),
    onSuccess: (r) => {
      toast.success("Camera added — configure it to turn analytics on");
      qc.invalidateQueries({ queryKey: ["people-cameras"] });
      setOpenCreate(false); setCreateForm(EMPTY_CREATE);
      if (r?.data?.id) setSelectedId(r.data.id);
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const createValid = createForm.name.trim() && createForm.rtsp_url.trim();

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-muted">
          Cameras · {list.length}
          {list.length > 0 && <> · <span className="text-green-500">{online} online</span> · <span className="text-foreground">{active} analysing</span></>}
        </div>
        <Button variant="success" icon="heroicons-outline:plus" onClick={() => { setCreateForm(EMPTY_CREATE); setOpenCreate(true); }}>Add camera</Button>
      </div>

      {cams.isLoading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : list.length === 0 ? (
        <EmptyState icon="heroicons-outline:video-camera" title="No cameras yet" subtitle="Add an RTSP source, then configure it and turn analytics on." action={<Button variant="success" icon="heroicons-outline:plus" onClick={() => setOpenCreate(true)}>Add camera</Button>} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_8fr] gap-4 lg:h-[calc(100vh-200px)]">
          {/* LEFT — camera list */}
          <div className="rounded-xl border border-card-border bg-card overflow-hidden flex flex-col lg:h-full min-h-[280px]">
            <div className="p-2.5 border-b border-card-border shrink-0">
              <div className="relative">
                <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-sm" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search cameras"
                  className="w-full rounded-md border border-field bg-transparent pl-8 pr-2 py-1.5 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-muted">No cameras match “{search}”.</div>
              ) : filtered.map((c) => {
                const sel = c.id === selectedId;
                return (
                  <button key={c.id} onClick={() => setSelectedId(c.id)}
                    className={`w-full text-left flex gap-3 items-center px-3 py-2.5 border-b border-card-border/60 transition ${sel ? "bg-primary/10" : "hover:bg-hover/50"}`}>
                    <div className="relative h-11 w-16 shrink-0 rounded-md overflow-hidden bg-black/40 flex items-center justify-center">
                      {c.snapshot_url ? <img src={fileUrl(c.snapshot_url)} alt="" className="h-full w-full object-cover" />
                        : <Icon icon="heroicons-outline:video-camera-slash" className="text-muted" />}
                      <span className={`absolute bottom-0.5 left-0.5 h-1.5 w-1.5 rounded-full ${c.status === "online" ? "bg-green-500" : c.status === "error" ? "bg-red-500" : "bg-slate-500"}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm truncate ${sel ? "font-semibold text-foreground" : "text-foreground"}`}>{c.name}</div>
                      <div className="text-xs text-muted truncate">{c.location || c.zone || "—"}</div>
                    </div>
                    {c.analytics_enabled
                      ? <Icon icon="heroicons-solid:sparkles" className="text-green-500 text-sm shrink-0" title="Analytics on" />
                      : <span className="text-[10px] text-muted shrink-0">off</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* RIGHT — selected camera config */}
          <div className="lg:h-full min-h-0">
            {selected ? (
              <CameraConfigPanel key={selected.id} camera={selected} qc={qc} onDeleted={() => setSelectedId(null)} />
            ) : (
              <div className="rounded-xl border border-dashed border-card-border lg:h-full flex flex-col items-center justify-center p-16 text-center text-sm text-muted">
                <Icon icon="heroicons-outline:cog-6-tooth" className="text-3xl mx-auto mb-2 opacity-60" />
                Select a camera to configure its parameters and scenarios.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Simple onboarding — params + scenarios live in the detail pane. */}
      <Modal open={openCreate} onClose={() => setOpenCreate(false)} title="Add camera"
        footer={<><Button variant="secondary" onClick={() => setOpenCreate(false)}>Cancel</Button><Button variant="success" disabled={!createValid || create.isPending} onClick={() => create.mutate({ name: createForm.name.trim(), rtsp_url: createForm.rtsp_url.trim(), location: createForm.location || null })}>{create.isPending ? "Adding…" : "Add camera"}</Button></>}>
        <div className="space-y-4">
          <Input label="Name" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} placeholder="e.g. Lobby entrance" autoFocus />
          <Input label="RTSP URL" value={createForm.rtsp_url} onChange={(e) => setCreateForm({ ...createForm, rtsp_url: e.target.value })} placeholder="rtsp://user:pass@host:554/stream" />
          <Input label="Location" value={createForm.location} onChange={(e) => setCreateForm({ ...createForm, location: e.target.value })} placeholder="Main lobby" />
          <p className="text-xs text-muted">The camera is added with analytics <strong>off</strong>. Configure parameters and scenarios in the detail pane, then turn analytics on.</p>
        </div>
      </Modal>
    </div>
  );
}
