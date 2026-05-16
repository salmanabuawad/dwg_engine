import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // autoUpdate: a new service worker installs silently and activates on
      // the next navigation. Combined with the skipWaiting / reload logic
      // in main.tsx, visible tabs reload automatically when a new build
      // ships — no stale UIs staying behind yesterday's JS.
      registerType: "autoUpdate",
      // Inject a light manifest so browsers treat this as an installable
      // PWA; nothing else in the app depends on the manifest, it is only
      // here so that Chrome / Safari will happily cache the shell.
      manifest: {
        name: "Solarica",
        short_name: "Solarica",
        description: "Solarica pier inspection — works offline in the field.",
        theme_color: "#0f172a",
        background_color: "#f8fafc",
        display: "standalone",
        start_url: "/",
        icons: [],
      },
      workbox: {
        // Cache the JS/CSS/HTML shell so the app opens without a network.
        // Maximum file size bumped so the MapLibre chunk is not skipped.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
        navigateFallback: "/index.html",
        // Never cache API responses — our IndexedDB layer handles that.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Serve /api/* requests straight from the network. The
            // IndexedDB layer in src/api.ts is the source of truth for
            // offline data; we explicitly do not want Workbox to shadow it.
            urlPattern: /\/api\//,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
      "/projects": "http://localhost:8000",
    },
  },
});
