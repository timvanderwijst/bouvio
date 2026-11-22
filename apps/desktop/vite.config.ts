import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The web client (`--mode web`): the same app, started from web/main.ts, with
 * a manifest and an offline shell from web/public, served by the hub at /app/.
 */
function webEntry(): Plugin {
  let base = "/";
  return {
    name: "cuna-web-entry",
    configResolved(c) {
      base = c.base;
    },
    transformIndexHtml(html) {
      const head = [
        `<link rel="manifest" href="${base}manifest.webmanifest" />`,
        `<link rel="icon" type="image/png" href="${base}icons/favicon-32.png" />`,
        `<link rel="apple-touch-icon" href="${base}icons/apple-touch-icon.png" />`,
        `<meta name="theme-color" content="#F4F4F3" media="(prefers-color-scheme: light)" />`,
        `<meta name="theme-color" content="#111112" media="(prefers-color-scheme: dark)" />`,
        `<meta name="apple-mobile-web-app-capable" content="yes" />`,
        `<meta name="mobile-web-app-capable" content="yes" />`,
      ].join("\n    ");
      return html
        .replace("</head>", `  ${head}\n  </head>`)
        .replace('content="width=device-width, initial-scale=1.0"', 'content="width=device-width, initial-scale=1.0, viewport-fit=cover"')
        .replace('src="/src/main.tsx"', 'src="/web/main.ts"');
    },
  };
}

// Tauri expects a fixed port and no clearing of its output.
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
    plugins: web ? [react(), webEntry()] : [react()],
    clearScreen: false,
    server: { port: 1420, strictPort: true, host: "127.0.0.1" },
    envPrefix: ["VITE_", "TAURI_ENV_"],
    publicDir: web ? "web/public" : "public",
    define: web ? { "import.meta.env.VITE_TARGET": JSON.stringify("web") } : {},
    build: { target: "es2022", sourcemap: !web },
  };
});
