// Shared People-Analytics UI helpers (badge colour maps, formatters, camera
// option lists). Ported from the FRS scenario's shared.js and re-themed for
// person analytics — no model/tech names surface in user-facing strings.

// Event-type badge colours. The four analytics scenarios each get a distinct hue.
export const EVENT_COLOR = {
  crowd_threshold: "amber",
  line_crossing: "blue",
  loitering: "indigo",
  intrusion: "red",
  person_detected: "slate",
};

// Human labels for the analytics event types (full form — use where there's room:
// page headers, Dashboard tiles, per-camera breakdown).
export const EVENT_LABEL = {
  crowd_threshold: "Crowd",
  line_crossing: "Line Crossing",
  loitering: "Loitering",
  intrusion: "Intrusion",
  person_detected: "Person",
};

// Compact labels for the TIGHT pill <Badge>s only (events-feed list, event-table
// Type column, detail-modal Type badge) — so "Line Crossing" doesn't wrap to two
// lines. Everywhere with room keeps the full EVENT_LABEL.
export const EVENT_BADGE = {
  crowd_threshold: "Crowd",
  line_crossing: "LC",
  loitering: "Loiter",
  intrusion: "Intrusion",
  person_detected: "Person",
};

// The four configurable scenarios (drives the Cameras editor + Events filter).
export const SCENARIOS = [
  { key: "crowd", event_type: "crowd_threshold", label: "Crowd", shape: "zone",
    icon: "heroicons-outline:user-group", color: "#f59e0b",
    desc: "Alert when more than N people occupy a zone." },
  { key: "counting", event_type: "line_crossing", label: "Line Counting", shape: "line",
    icon: "heroicons-outline:arrows-right-left", color: "#3b82f6",
    desc: "Count people crossing a virtual line." },
  { key: "loitering", event_type: "loitering", label: "Loitering", shape: "zone",
    icon: "heroicons-outline:clock", color: "#8b5cf6",
    desc: "Alert when a person lingers in a zone too long." },
  { key: "intrusion", event_type: "intrusion", label: "Intrusion", shape: "zone",
    icon: "heroicons-outline:shield-exclamation", color: "#ef4444",
    desc: "Alert on any person entering a restricted zone." },
];

// --- cameras ---------------------------------------------------------------
export const CAM_STATUS_COLOR = { online: "green", offline: "slate", error: "red", connecting: "amber" };

export const CAM_HWACCEL = [
  { value: "none", label: "CPU (software)" },
  { value: "nvdec", label: "NVDEC (GPU)" },
];

// Max width frames are downscaled to for analysis (0 = native). Values are strings
// so they bind cleanly to a <select>; the caller converts back to Number on save.
export const CAM_ANALYZE_RES = [
  { value: "0", label: "Native (full resolution)" },
  { value: "1920", label: "1080p (1920 wide) — recommended" },
  { value: "1280", label: "720p (1280 wide) — lowest CPU" },
  { value: "960", label: "960 wide — very low CPU" },
];

// Normalise a stored counting line into a straight segment expressed in the 0..100
// SVG space shared by the zones + person boxes (the overlay SVG uses
// viewBox="0 0 100 100" preserveAspectRatio="none", i.e. 0..1 → 0..100 on each
// axis independently). The canonical shape is two normalised points
// [[x1,y1],[x2,y2]]; we also defensively repair a flat [x1,y1,x2,y2] and coerce
// string numbers. Returns {x1,y1,x2,y2} in 0..100, or null if it isn't a usable
// 2-point line — so callers always draw a straight <line> between the two ends
// (never a stray diagonal from a malformed/partial value).
export function lineSeg(line) {
  if (!Array.isArray(line)) return null;
  let a, b;
  if (line.length >= 2 && Array.isArray(line[0]) && Array.isArray(line[1])) {
    a = line[0];
    b = line[1];
  } else if (line.length === 4 && line.every((n) => typeof n === "number")) {
    a = [line[0], line[1]];
    b = [line[2], line[3]];
  } else {
    return null;
  }
  const x1 = Number(a[0]), y1 = Number(a[1]), x2 = Number(b[0]), y2 = Number(b[1]);
  if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) return null;
  return { x1: x1 * 100, y1: y1 * 100, x2: x2 * 100, y2: y2 * 100 };
}

export function confColor(c) {
  if (c == null) return "slate";
  if (c >= 0.85) return "green";
  if (c >= 0.6) return "amber";
  return "red";
}

export function fmt(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

export function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString();
}

export function fmtDuration(sec) {
  if (sec == null) return "—";
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function pct(v) {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}
