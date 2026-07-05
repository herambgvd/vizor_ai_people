// People Analytics portal top navigation. This is a dedicated single-scenario app; its
// feature modules are the primary (flat, perm-gated) navigation alongside Dashboard
// and Audit. Settings groups the common admin sub-pages.
// Scenario UI lives in this app's own `views/` (NOT platform/web).
export const menuItems = [
  { title: "Dashboard", icon: "heroicons-outline:home", link: "/" },
  { title: "Home", icon: "heroicons-outline:squares-2x2", link: "/home", perm: "people-analytics.read" },
  // Add this scenario's feature nav items here.
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
