"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { api, fileUrl, tokens } from "@/web/api";
import { Badge, Modal, Select } from "@/web/kit";

import { EVENT_BADGE, EVENT_COLOR, EVENT_LABEL, SCENARIOS, fmt, fmtTime, lineSeg } from "./shared";
import { useFeatures } from "./useFeatures";

// VMS grid layouts: cell-count -> column-count.
const LAYOUTS = [
  { n: 1, cols: 1 }, { n: 4, cols: 2 }, { n: 9, cols: 3 }, { n: 16, cols: 4 },
  { n: 25, cols: 5 }, { n: 36, cols: 6 }, { n: 48, cols: 8 },
];
// event_type -> scenario icon (bottom-overlay cue on a tile).
const EVENT_ICON = Object.fromEntries(SCENARIOS.map((s) => [s.event_type, s.icon]));

// --- Simple alert cue -------------------------------------------------------
// A single soft beep whenever a new analytics alert lands. Guarded so an
// autoplay-block or an unsupported browser never throws (events still render).
let _audioCtx = null;
function beep() {
  try {
    if (typeof window === "undefined") return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!_audioCtx) _audioCtx = new Ctx();
    if (_audioCtx.state === "suspended") _audioCtx.resume().catch(() => {});
    const at = _audioCtx.currentTime;
    const o = _audioCtx.createOscillator();
    const g = _audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.15, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
    o.connect(g).connect(_audioCtx.destination);
    o.start(at);
    o.stop(at + 0.14);
  } catch { /* autoplay policy / unsupported — ignore */ }
}

// Low-latency WebRTC playback via MediaMTX WHEP (sub-second vs HLS's ~5–10s).
async function startWhep(video, whepUrl, onFail) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });
  pc.ontrack = (e) => {
    if (video && e.streams && e.streams[0]) {
      video.srcObject = e.streams[0];
      video.play?.().catch(() => {});
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.iceConnectionState)) onFail?.();
  };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(resolve, 1500);
  });
  const res = await fetch(whepUrl, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription.sdp,
  });
  if (!res.ok) { pc.close(); throw new Error(`WHEP ${res.status}`); }
  const answer = await res.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  return pc;
}

// Configured scenario zones/lines drawn over the tile (normalised 0..1 coords).
// Only LICENSED scenarios are ever drawn — an unlicensed zone/line is never shown.
function ScenarioShapes({ scenarios, licensedIds }) {
  const s = scenarios || {};
  const shapes = [];
  const labels = [];   // HTML overlays (SVG text distorts under the non-uniform stretch)
  for (const meta of SCENARIOS) {
    if (licensedIds && !licensedIds.has(meta.key)) continue;
    const cfg = s[meta.key];
    if (!cfg?.enabled) continue;
    if (meta.shape === "zone" && Array.isArray(cfg.zone) && cfg.zone.length > 1) {
      shapes.push(<polygon key={meta.key} points={cfg.zone.map((p) => `${p[0] * 100},${p[1] * 100}`).join(" ")}
        fill={`${meta.color}22`} stroke={meta.color} strokeWidth="0.4" vectorEffect="non-scaling-stroke" />);
    } else if (meta.shape === "line") {
      // Straight segment from point0 → point1 in the SAME 0..100 space as the zones
      // (viewBox below) and the person boxes. lineSeg() guards malformed/partial data.
      const seg = lineSeg(cfg.line);
      if (seg) {
        // A clear, bold, dashed crossing line (0.6px non-scaling was near-invisible).
        shapes.push(<line key={`${meta.key}-halo`} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
          stroke="rgba(0,0,0,0.5)" strokeWidth="5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />);
        shapes.push(<line key={meta.key} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
          stroke={meta.color} strokeWidth="3" strokeDasharray="7 5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />);
        // IN / OUT side labels. The engine tags a crossing "in" when the person's foot
        // lands on the LEFT of the directed line point0→point1 — i.e. the (-dy, dx)
        // normal side. We place the labels on those matching sides (in 0..100 space).
        const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;               // unit normal -> IN side
        const mx = (seg.x1 + seg.x2) / 2, my = (seg.y1 + seg.y2) / 2;
        const off = 11;                                    // offset from the line (0..100)
        const clamp = (v) => Math.max(5, Math.min(95, v));
        labels.push(
          <span key={`${meta.key}-in`} style={{ left: `${clamp(mx + nx * off)}%`, top: `${clamp(my + ny * off)}%` }}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-emerald-500/90 px-1.5 py-0.5 text-[10px] font-bold text-black shadow">IN ↓</span>
        );
        labels.push(
          <span key={`${meta.key}-out`} style={{ left: `${clamp(mx - nx * off)}%`, top: `${clamp(my - ny * off)}%` }}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-bold text-black shadow">OUT ↑</span>
        );
      }
    }
  }
  if (!shapes.length && !labels.length) return null;
  return (
    <>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full pointer-events-none">{shapes}</svg>
      {labels}
    </>
  );
}

// One VMS wall tile. Streams ONLY when analytics is enabled on the camera. Draws
// live person boxes (from the overlays poll) on a canvas, a live person-count
// badge, and the camera's configured scenario zones/lines.
function Tile({ cam, overlay, last, inout, annotated, licensedIds, countingLicensed }) {
  const videoRef = useRef(null);
  const [state, setState] = useState("connecting"); // connecting | live | offline | unavailable | scenario_off

  const online = cam?.status === "online";
  const aiOn = !!cam && cam.analytics_enabled;
  // 1-up "annotated" mode: show the worker's boxes-burned-in MJPEG stream (perfectly
  // synced) instead of the raw WebRTC feed. Only used for the single expanded camera.
  const annUrl = (annotated && cam && online && aiOn)
    ? `${api.defaults.baseURL}/people/live/annotated/${cam.id}?token=${encodeURIComponent(tokens.access || "")}`
    : null;

  // Live video (WebRTC wall): only stream when analytics is on AND we're not in the
  // annotated single-camera view (which uses the MJPEG <img> below instead).
  useEffect(() => {
    if (typeof window === "undefined" || !cam || annotated) return undefined;
    if (!online) { setState("offline"); return undefined; }
    if (!aiOn) { setState("scenario_off"); return undefined; }
    let cancelled = false;
    let pc = null;
    setState("connecting");
    (async () => {
      let webrtc;
      try {
        const r = await api.post(`/people/live/streams/${cam.id}`);
        webrtc = r?.data?.webrtc;
      } catch {
        if (!cancelled) setState("unavailable");
        return;
      }
      const video = videoRef.current;
      if (cancelled || !webrtc || !video) { if (!cancelled) setState("unavailable"); return; }
      const whepUrl = webrtc.replace(/\/+$/, "") + "/whep";
      try {
        pc = await startWhep(video, whepUrl, () => { if (!cancelled) setState("unavailable"); });
      } catch {
        if (!cancelled) setState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
      if (pc) { try { pc.close(); } catch { /* noop */ } }
      const v = videoRef.current;
      if (v) { try { v.srcObject = null; } catch { /* noop */ } }
    };
  }, [cam?.id, online, aiOn]);

  // Annotated-mode base state (the MJPEG <img> flips it to "live" on first frame).
  useEffect(() => {
    if (!annotated || !cam) return;
    if (!online) setState("offline");
    else if (!aiOn) setState("scenario_off");
    else setState("connecting");
  }, [annotated, cam?.id, online, aiOn]);

  // NOTE: on the multi-cam WALL per-person bounding boxes are deliberately NOT drawn.
  // Analysis (person detection @ analyze-fps, via its own RTSP decode) and the WebRTC
  // wall are two independent pipelines with different, variable latency, so a box
  // would always trail a walking person. We show the sync-independent signals instead:
  // a live person-count badge and the static configured zones/lines. Per-person crops
  // are still shown on event snapshots (Events tab), where they're pixel-accurate.

  if (!cam) {
    return <div className="relative bg-black rounded-sm border border-white/5 flex items-center justify-center"><Icon icon="heroicons-outline:video-camera-slash" className="text-white/10 text-2xl" /></div>;
  }

  const count = overlay?.count;

  return (
    <div className="relative bg-black rounded-sm overflow-hidden border border-white/10 group">
      {annUrl ? (
        // 1-up: boxes-burned-in MJPEG stream (perfectly synced with the video).
        <img src={annUrl} alt="" onLoad={() => setState("live")} onError={() => setState("unavailable")}
          className="absolute inset-0 h-full w-full object-cover bg-black" />
      ) : (
        <video ref={videoRef} autoPlay muted playsInline onPlaying={() => setState("live")}
          className="absolute inset-0 h-full w-full object-cover bg-black" />
      )}
      {/* configured scenario zones/lines (static, always correct) — licensed only */}
      {aiOn && <ScenarioShapes scenarios={cam.scenarios} licensedIds={licensedIds} />}

      {/* Line-counting IN / OUT badge — shown when the counting scenario is on AND
          licensed. Counts are today's totals (DB-accurate) and tick up as people cross. */}
      {aiOn && countingLicensed && cam.scenarios?.counting?.enabled && (
        <div className="absolute top-8 left-2 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[11px] font-semibold tabular-nums shadow">
          <Icon icon="heroicons-solid:arrow-right-circle" className="text-emerald-400 text-sm" />
          <span className="text-emerald-400">IN {inout?.in ?? 0}</span>
          <span className="text-white/30">·</span>
          <Icon icon="heroicons-solid:arrow-left-circle" className="text-amber-400 text-sm" />
          <span className="text-amber-400">OUT {inout?.out ?? 0}</span>
        </div>
      )}

      {/* placeholder when not live */}
      {state !== "live" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
          {state === "offline" ? (
            <><Icon icon="heroicons-outline:video-camera-slash" className="text-white/20 text-3xl" /><span className="text-[10px] uppercase tracking-wider text-white/40">{cam.status}</span></>
          ) : state === "scenario_off" ? (
            <><Icon icon="heroicons-outline:pause-circle" className="text-white/20 text-3xl" /><span className="text-[10px] uppercase tracking-wider text-white/40">analytics off</span><span className="text-[9px] text-white/30 px-4">enable analytics to view live</span></>
          ) : state === "unavailable" ? (
            <><Icon icon="heroicons-outline:exclamation-triangle" className="text-white/25 text-3xl" /><span className="text-[10px] uppercase tracking-wider text-white/40">unavailable</span></>
          ) : (
            <><Icon icon="heroicons-outline:signal" className="text-white/25 text-2xl animate-pulse" /><span className="text-[10px] uppercase tracking-wider text-white/40">connecting…</span></>
          )}
        </div>
      )}

      {/* top bar: status dot + name + live person count */}
      <div className="absolute top-0 inset-x-0 flex items-center gap-1.5 px-2 py-1 bg-gradient-to-b from-black/70 to-transparent">
        <span className={`h-2 w-2 rounded-full shrink-0 ${online ? "bg-green-500" : cam.status === "error" ? "bg-red-500" : "bg-slate-500"}`} />
        <span className="text-[11px] font-medium text-white/90 truncate">{cam.name}</span>
        {aiOn && count != null && (
          <span className="ml-auto flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums">
            <Icon icon="heroicons-solid:user-group" className="text-[11px] text-green-400" />{count}
          </span>
        )}
        {!online && count == null && <span className="ml-auto text-[9px] uppercase tracking-wider text-white/50">{cam.status}</span>}
      </div>

      {/* bottom overlay: latest analytics event on this camera */}
      {last && (
        <div className="absolute bottom-0 inset-x-0 flex items-center gap-1.5 px-2 py-1 bg-gradient-to-t from-black/80 to-transparent">
          <Icon icon={EVENT_ICON[last.event_type] || "heroicons-solid:bell-alert"} className={`shrink-0 text-${EVENT_COLOR[last.event_type] || "slate"}-400`} />
          <span className="text-[11px] text-white truncate">{last.title || EVENT_LABEL[last.event_type] || last.event_type}</span>
          {last.count != null && <span className="ml-auto text-[10px] tabular-nums text-white/80">{last.count}</span>}
        </div>
      )}
    </div>
  );
}

// Full-frame snapshot with the detection box overlaid.
function SnapshotWithBox({ url, bbox }) {
  const [dims, setDims] = useState(null);
  if (!url) return <Icon icon="heroicons-outline:photo" className="text-4xl text-muted" />;
  const box = Array.isArray(bbox) && bbox.length === 4 ? bbox.map(Number) : null;
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
  return <><dt className="text-muted">{label}</dt><dd className="text-foreground min-w-0 truncate">{children}</dd></>;
}

// Complete-info modal for a Live event (opened by clicking a card in the feed).
function LiveEventModal({ event, onClose }) {
  const e = event;
  return (
    <Modal open={!!e} onClose={onClose} title="Event details" wide>
      {e && (
        <div className="grid md:grid-cols-5 gap-4 items-stretch">
          <div className="md:col-span-3 flex flex-col">
            <div className="text-[10px] uppercase tracking-wider text-muted mb-1.5">Snapshot</div>
            <div className="flex-1 min-h-[240px] rounded-lg bg-black/40 border border-card-border overflow-hidden flex items-center justify-center">
              <SnapshotWithBox url={e.snapshot_url} bbox={e.bbox} />
            </div>
          </div>
          <div className="md:col-span-2 flex flex-col">
            <dl className="grid grid-cols-[92px_1fr] gap-x-3 gap-y-2 text-sm items-center">
              <Row label="Type"><Badge color={EVENT_COLOR[e.event_type] || "slate"}>{EVENT_BADGE[e.event_type] || EVENT_LABEL[e.event_type] || e.event_type}</Badge></Row>
              {e.attributes?.direction && (
                <Row label="Direction">
                  <Badge color={e.attributes.direction === "in" ? "green" : "amber"}>
                    {e.attributes.direction === "in" ? "IN ↓" : "OUT ↑"}
                  </Badge>
                </Row>
              )}
              {e.title && <Row label="Title">{e.title}</Row>}
              {e.count != null && <Row label="Count">{e.count}</Row>}
              {e.attributes?.dwell_seconds != null && <Row label="Dwell">{e.attributes.dwell_seconds}s</Row>}
              {e.zone_name && <Row label="Zone">{e.zone_name}</Row>}
              {e.severity && <Row label="Severity"><Badge color={e.severity === "high" ? "red" : e.severity === "medium" ? "amber" : "slate"}>{e.severity}</Badge></Row>}
              <Row label="Camera">{e.camera_name || "—"}</Row>
              {e.track_id != null && <Row label="Track">{e.track_id}</Row>}
              <Row label="Time">{fmt(e.triggered_at)}</Row>
            </dl>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function LiveTab() {
  const { licensedIds, licensedEventTypes, isLicensed } = useFeatures();
  const [layout, setLayout] = useState(9);
  const [showFeed, setShowFeed] = useState(false);
  const [selectedCamId, setSelectedCamId] = useState("");
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [muted, setMuted] = useState(false);
  const lastAlertIdRef = useRef(null);

  const cams = useQuery({
    queryKey: ["people-cameras"],
    queryFn: () => api.get("/people/cameras").then((r) => r.data),
    refetchInterval: 15000,
  });
  const live = useQuery({
    queryKey: ["people-live"],
    queryFn: () => api.get("/people/live", { params: { limit: 50 } }).then((r) => r.data.items),
    refetchInterval: 3000,
  });
  // Live person boxes + counts per camera — polled ~2/s.
  const overlays = useQuery({
    queryKey: ["people-overlays"],
    queryFn: () => api.get("/people/live/overlays").then((r) => r.data),
    refetchInterval: 500,
  });
  // Per-camera In/Out tallies (DB-accurate, today) for the line-counting badge.
  const summary = useQuery({
    queryKey: ["people-summary-live"],
    queryFn: () => api.get("/people/analytics/summary", { params: { since_hours: 24 } }).then((r) => r.data),
    refetchInterval: 2000,
  });

  const cameras = cams.data || [];
  // Only show events for LICENSED scenarios in the live feed.
  const feed = (live.data || []).filter((e) => licensedEventTypes.has(e.event_type));
  const overlayMap = overlays.data || {};
  const inoutMap = {};
  for (const c of summary.data?.cameras || []) inoutMap[c.camera_id] = { in: c.in_count, out: c.out_count };
  const online = cameras.filter((c) => c.status === "online").length;
  const cols = LAYOUTS.find((l) => l.n === layout)?.cols || 3;
  const single = cameras.find((c) => c.id === selectedCamId) || cameras[0] || null;
  const cells = layout === 1 ? [single] : Array.from({ length: layout }, (_, i) => cameras[i] || null);
  const latestByCam = (id) => feed.find((e) => e.camera_id === id);

  // Soft beep on a newly-arrived alert (top of the feed changed).
  useEffect(() => {
    const top = feed[0];
    if (!top) return;
    if (lastAlertIdRef.current == null) { lastAlertIdRef.current = top.id; return; }
    if (top.id !== lastAlertIdRef.current) {
      lastAlertIdRef.current = top.id;
      if (!muted) beep();
    }
  }, [feed, muted]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-2 shrink-0">
        <span className="flex items-center gap-1.5 text-xs"><span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" /><span className="text-muted">LIVE</span></span>
        <span className="text-sm text-muted"><span className="text-green-500">{online}</span> / {cameras.length} online</span>
        {layout === 1 && cameras.length > 0 && (
          <div className="w-52">
            <Select options={cameras.map((c) => ({ value: c.id, label: c.name }))} value={single?.id || ""} onChange={(e) => setSelectedCamId(e.target.value)} placeholder="Select camera" />
          </div>
        )}
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-card-border bg-card p-0.5">
          {LAYOUTS.map((l) => (
            <button key={l.n} onClick={() => setLayout(l.n)} title={`${l.n}-up`}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${layout === l.n ? "bg-foreground text-background" : "text-muted hover:text-foreground hover:bg-hover"}`}>
              {l.n}
            </button>
          ))}
        </div>
        <button onClick={() => setMuted((m) => !m)} aria-pressed={muted}
          title={muted ? "Unmute alert sound" : "Mute alert sound"}
          className={`inline-flex items-center justify-center h-8 w-8 rounded-md border transition ${muted ? "border-card-border text-muted hover:text-foreground hover:bg-hover" : "bg-foreground text-background border-foreground"}`}>
          <Icon icon={muted ? "heroicons-outline:speaker-x-mark" : "heroicons-outline:speaker-wave"} className="text-base" />
        </button>
        <button onClick={() => setShowFeed((v) => !v)} title="Events feed"
          className={`inline-flex items-center justify-center h-8 w-8 rounded-md border transition ${showFeed ? "bg-foreground text-background border-foreground" : "border-card-border text-muted hover:text-foreground hover:bg-hover"}`}>
          <Icon icon="heroicons-outline:bell-alert" className="text-base" />
        </button>
      </div>

      {/* Wall + optional feed */}
      <div className="flex-1 min-h-0 flex gap-2">
        {cameras.length === 0 && !cams.isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted border border-dashed border-card-border rounded-lg">
            <Icon icon="heroicons-outline:video-camera-slash" className="text-4xl mb-2" />
            <span className="text-sm">No cameras — add one to see the wall.</span>
          </div>
        ) : (
          <div className="flex-1 min-h-0 grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "1fr" }}>
            {cells.map((cam, i) => <Tile key={cam?.id || `empty-${i}`} cam={cam} overlay={cam ? overlayMap[cam.id] : null} last={cam ? latestByCam(cam.id) : null} inout={cam ? inoutMap[cam.id] : null} annotated={layout === 1} licensedIds={licensedIds} countingLicensed={isLicensed("counting")} />)}
          </div>
        )}

        {showFeed && (
          <div className="w-72 shrink-0 rounded-lg border border-card-border bg-card flex flex-col min-h-0 overflow-hidden">
            <div className="px-3 py-2 border-b border-card-border text-xs uppercase tracking-wider text-muted">Events</div>
            {feed.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-muted text-sm gap-2"><Icon icon="heroicons-outline:signal" className="text-2xl" />Waiting for events…</div>
            ) : (
              <ul className="flex-1 min-h-0 overflow-y-auto divide-y divide-card-border">
                {feed.map((e) => (
                  <li key={e.id}>
                    <button type="button" onClick={() => setSelectedEvent(e)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-hover transition cursor-pointer">
                      <div className="h-9 w-9 rounded-md bg-black/40 overflow-hidden shrink-0 flex items-center justify-center">
                        {e.snapshot_url ? <img src={fileUrl(e.snapshot_url)} alt="" className="h-full w-full object-cover" /> : <Icon icon="heroicons-outline:user" className="text-muted" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-foreground truncate">{e.title || EVENT_LABEL[e.event_type] || e.event_type}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <Badge color={EVENT_COLOR[e.event_type] || "slate"}>{EVENT_BADGE[e.event_type] || EVENT_LABEL[e.event_type] || e.event_type}</Badge>
                          <span className="text-[11px] text-muted truncate">{e.camera_name || "—"} · {fmtTime(e.triggered_at)}</span>
                        </div>
                      </div>
                      {e.count != null && <span className={`text-[11px] tabular-nums text-${EVENT_COLOR[e.event_type] || "slate"}-500`}>{e.count}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <LiveEventModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </div>
  );
}
