// Post-process the source-app build served from /source-app/.
//
// The build uses base "/" so shared assets (/icon.png, /fonts.css,
// /nori-*.js) and API paths stay rooted correctly. But the app's OWN emitted
// JS/CSS are written to /source-app/assets/, so their hrefs must be rewritten
// to ./assets/* to avoid resolving against the historical /assets/* chunks.
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] || "public/source-app");
const indexPath = path.join(dir, "index.html");
let html = fs.readFileSync(indexPath, "utf8");

const emitted = fs.readdirSync(path.join(dir, "assets"));
const js = emitted.find((f) => /^index-.*\.js$/.test(f));
const css = emitted.find((f) => /^index-.*\.css$/.test(f));

if (!js) throw new Error(`no emitted index-*.js in ${dir}/assets`);

const before = html;
html = html.replace(new RegExp(`src="/assets/${js.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `src="./assets/${js}"`);
if (css) {
  html = html.replace(new RegExp(`href="/assets/${css.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `href="./assets/${css}"`);
}

if (html === before) {
  console.warn("[source-app] no paths rewritten; check emitted asset names");
} else {
  fs.writeFileSync(indexPath, html, "utf8");
  console.log(`[source-app] rewrote own assets to ./assets/ (${js}${css ? `, ${css}` : ""})`);
}
