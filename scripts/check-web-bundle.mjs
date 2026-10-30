#!/usr/bin/env node
// Checks the ALREADY BUILT web bundle (dist-web/): no Tauri inside, and the right base.
// The source can be clean and the bundle not — an indirect import is enough to drag
// in the Tauri API — which is why the output is inspected, not the code.
//
// Usage: node scripts/check-web-bundle.mjs   (already run by `npm run build:web`)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist-web");
const BASE = "/noema/pragma-live/";

// Traces that must not be in a browser bundle: Tauri API modules leave
// these names (`__TAURI_INTERNALS__`, the `plugin:...|` commands). `tauri://` is not searched: App.vue
// listens to its drag & drop events by name, and on the web those listeners are idle.
const FORBIDDEN = [
  ["__TAURI", "l'API di Tauri (window.__TAURI_INTERNALS__)"],
  ["@tauri-apps", "un import di @tauri-apps"],
  ["plugin:notification|", "il plugin di notifiche di Tauri"],
  ["plugin:window|", "il plugin finestra di Tauri"],
];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const problems = [];
let files;
try {
  files = walk(DIST);
} catch {
  console.error("\n  ✗ dist-web/ does not exist: run `vite build --mode web` first.\n");
  process.exit(1);
}

for (const f of files.filter((p) => /\.(js|css|html)$/.test(p))) {
  const text = readFileSync(f, "utf8");
  for (const [needle, what] of FORBIDDEN) {
    if (text.includes(needle)) problems.push(`${f.slice(DIST.length + 1)}: contiene ${what}`);
  }
}

const index = readFileSync(join(DIST, "index.html"), "utf8");
if (!index.includes(`"${BASE}assets/`)) {
  problems.push(`index.html: assets do not start from ${BASE} (wrong base)`);
}

if (problems.length > 0) {
  console.error("\n  ✗ bundle web non valido:\n" + problems.map((p) => `    - ${p}`).join("\n") + "\n");
  process.exit(1);
}
console.log(`  ✓ dist-web/: ${files.length} file, nessuna traccia di Tauri, base ${BASE}`);
