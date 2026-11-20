// Entry of the web build (`pnpm build:web`, served by the hub at /app/).
// Marks the page as the web client, registers the offline shell, then starts
// the same app the desktop runs.
document.documentElement.classList.add("is-web");

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
  });
}

import("../src/main");
