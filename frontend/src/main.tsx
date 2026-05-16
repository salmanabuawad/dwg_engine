import React from "react";
import ReactDOM from "react-dom/client";
import { ModuleRegistry, AllCommunityModule } from "ag-grid-community";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./i18n/i18n";
import "./index.css";

ModuleRegistry.registerModules([AllCommunityModule]);

// Service-worker update + offline support
// ----------------------------------------
// vite-plugin-pwa is configured as `registerType: "autoUpdate"` — a new
// SW installs in the background and sends `skipWaiting()` automatically.
// Once the new SW takes control, `controllerchange` fires; we use that as
// the cue to reload so open tabs don't keep running the old JS bundle.
// The same SW also Workbox-precaches the app shell (JS/CSS/HTML/icons),
// so the app boots fully offline after a single online visit.
if (typeof window !== "undefined") {
  registerSW({ immediate: true, onRegisteredSW() { /* ok */ }, onOfflineReady() { /* shell cached */ } });

  if ("serviceWorker" in navigator) {
    let didReload = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (didReload) return;   // avoid the reload loop Chrome otherwise does on first activation
      didReload = true;
      window.location.reload();
    });
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode><App /></React.StrictMode>
);
