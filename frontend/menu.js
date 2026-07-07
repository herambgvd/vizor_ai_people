// People Analytics portal top navigation. This is a dedicated multi-scenario app; its
// LICENSED scenario modules are the primary navigation alongside Dashboard and Audit.
// Settings groups the common admin sub-pages. Scenario UI lives in this app's own
// `views/` (NOT platform/web).
//
// The four scenario entries carry `featureGated: <module id>`: Header keeps only the
// ones present in GET /features (the licensed modules) — so a client licensed for a
// single scenario sees only that page in the nav. Items WITHOUT `featureGated` are
// unaffected (the flag is purely additive). The old unified "Events" page is gone —
// each scenario now has its own page.
export const menuItems = [
  { title: "Dashboard", icon: "heroicons-outline:home", link: "/" },
  { title: "Cameras", icon: "heroicons-outline:video-camera", link: "/cameras", perm: "people-analytics.read" },
  { title: "Live", icon: "heroicons-outline:signal", link: "/live", perm: "people-analytics.read" },
  { title: "Crowd Counting", icon: "heroicons-outline:user-group", link: "/crowd", perm: "people-analytics.read", featureGated: "crowd" },
  { title: "People Counting", icon: "heroicons-outline:arrows-right-left", link: "/counting", perm: "people-analytics.read", featureGated: "counting" },
  { title: "Loitering", icon: "heroicons-outline:clock", link: "/loitering", perm: "people-analytics.read", featureGated: "loitering" },
  { title: "Intrusion", icon: "heroicons-outline:shield-exclamation", link: "/intrusion", perm: "people-analytics.read", featureGated: "intrusion" },
  { title: "Audit", icon: "heroicons-outline:clipboard-document-list", link: "/audit", perm: "audit.read" },
  {
    title: "Settings",
    icon: "heroicons-outline:cog-6-tooth",
    children: [
      { title: "Users", icon: "heroicons-outline:users", link: "/users", perm: "user.read" },
      { title: "Roles & Permissions", icon: "heroicons-outline:shield-check", link: "/roles", perm: "role.read" },
      { title: "API Keys", icon: "heroicons-outline:key", link: "/api-keys", perm: "apikey.manage" },
      { title: "Branding", icon: "heroicons-outline:swatch", link: "/branding", perm: "branding.manage" },
      { title: "Channels", icon: "heroicons-outline:bell-alert", link: "/channels", perm: "settings.manage" },
      { title: "Email Templates", icon: "heroicons-outline:envelope", link: "/email-templates", perm: "settings.manage" },
      { title: "General", icon: "heroicons-outline:adjustments-horizontal", link: "/general", perm: "settings.manage" },
      { title: "System Health", icon: "heroicons-outline:heart", link: "/system-health", perm: "system.read" },
      { title: "License", icon: "heroicons-outline:check-badge", link: "/license" },
    ],
  },
];
