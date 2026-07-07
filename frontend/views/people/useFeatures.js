"use client";

// License-driven feature discovery for the People-Analytics portal.
//
// GET /api/v1/features returns the LICENSED scenario modules only (in dev mode all
// four are returned). This hook exposes that list plus a few helpers so pages,
// nav, Dashboard, Live and the Cameras editor can all hide anything the client
// hasn't licensed. The /features nav payload is {id,name,icon,path}; it does NOT
// carry event_type or directional, so we merge in the static per-id metadata below
// (colours/labels reuse shared.js).

import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/api";

// The four possible scenario modules, keyed by license id. `key`/`id` also match
// the Cameras editor scenario keys and the Dashboard SCENARIOS keys.
export const SCENARIO_META = {
  crowd: {
    id: "crowd", event_type: "crowd_threshold", directional: false,
    color: "#f59e0b", label: "Crowd Counting", name: "Crowd Counting",
    icon: "heroicons-outline:user-group", path: "/crowd",
  },
  counting: {
    id: "counting", event_type: "line_crossing", directional: true,
    color: "#3b82f6", label: "People Counting", name: "People Counting",
    icon: "heroicons-outline:arrows-right-left", path: "/counting",
  },
  loitering: {
    id: "loitering", event_type: "loitering", directional: false,
    color: "#8b5cf6", label: "Loitering", name: "Loitering",
    icon: "heroicons-outline:clock", path: "/loitering",
  },
  intrusion: {
    id: "intrusion", event_type: "intrusion", directional: false,
    color: "#ef4444", label: "Intrusion", name: "Intrusion",
    icon: "heroicons-outline:shield-exclamation", path: "/intrusion",
  },
};

export const SCENARIO_IDS = ["crowd", "counting", "loitering", "intrusion"];

// event_type -> scenario id, for filtering event streams by what's licensed.
export const EVENT_TYPE_TO_ID = Object.fromEntries(
  SCENARIO_IDS.map((id) => [SCENARIO_META[id].event_type, id]),
);

// Shared query so every consumer (nav Header, pages, Live, Dashboard, Cameras)
// hits /features once and stays in sync via the TanStack cache.
export function featuresQueryOptions() {
  return {
    queryKey: ["features"],
    queryFn: () => api.get("/features").then((r) => r.data),
    staleTime: 60_000,
  };
}

export function useFeatures() {
  const q = useQuery(featuresQueryOptions());

  const modules = q.data?.modules || [];
  const licensedIds = new Set(modules.map((m) => m.id));
  const isLicensed = (id) => licensedIds.has(id);

  // id -> merged { ...static meta, ...nav-from-/features } for every known
  // scenario (licensed or not); `licensed` flags which ones the client owns.
  const byId = {};
  for (const id of SCENARIO_IDS) {
    const nav = modules.find((m) => m.id === id) || null;
    byId[id] = { ...SCENARIO_META[id], ...(nav || {}), licensed: !!nav };
  }

  // Licensed modules only, in the order /features returned them, merged with meta.
  const licensedModules = modules
    .filter((m) => SCENARIO_META[m.id])
    .map((m) => ({ ...SCENARIO_META[m.id], ...m, licensed: true }));

  // Set of event_types the client is licensed for (for filtering event feeds).
  const licensedEventTypes = new Set(licensedModules.map((m) => m.event_type));

  return {
    features: q.data,
    modules,              // raw nav modules from /features (licensed only)
    licensedModules,      // merged with static meta
    licensedIds,
    licensedEventTypes,
    isLicensed,
    byId,
    isLoading: q.isLoading,
    isError: q.isError,
  };
}
