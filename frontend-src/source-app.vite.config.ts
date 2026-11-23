import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceRoot, "..");

/**
 * Development-only build: the recovered source app served from
 * /source-app/ alongside the historical production entry.
 *
 * - Absolute base "/" keeps shared assets (/icon.png, /fonts.css,
 *   /nori-*-settings.js) and API calls (/api/*) pointing at the site root.
 * - Only the app's own JS/CSS are emitted under public/source-app/assets;
 *   a post-build step rewrites those two <script>/<link> hrefs to ./assets/*
 *   so they resolve inside the subpath instead of hitting the historical
 *   /assets/* chunks shipped with the production entry.
 * - copyPublicDir is off: shared assets stay in the single root public/.
 */
export default defineConfig({
  root: sourceRoot,
  base: "/",
  publicDir: resolve(projectRoot, "public"),
  plugins: [react()],
  build: {
    outDir: resolve(projectRoot, "public", "source-app"),
    emptyOutDir: true,
    copyPublicDir: false,
    sourcemap: true,
    target: "es2022",
    assetsDir: "assets",
  },
});
