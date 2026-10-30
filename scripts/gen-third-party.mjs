#!/usr/bin/env node
// Generates THIRD-PARTY-NOTICES.md — the attribution of third-party dependencies
// that ship inside the distributed binary.
//
// Why it exists: practically every Rust crate and npm package Pragma Symphony
// builds on is MIT or Apache-2.0, and *both* require the copyright notice to
// accompany a binary distribution — having it in the source is not enough.
// The obligation does not depend on the licence Pragma picks for itself: it applies anyway.
//
// Two halves, collected separately because the two ecosystems share nothing:
//   - Rust: `cargo about`, configured in about.toml + about.hbs;
//   - npm : the tree of production dependencies only, read from node_modules.
//     devDependencies (vite, vitest, wdio, playwright…) stay out: they do not
//     end up in dist/, so they are not distributed and need no attribution.
//
// Usage:  npm run notices

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "THIRD-PARTY-NOTICES.md");

// The names under which npm packages store the licence text: no standard,
// just convention. Order = preference.
const LICENSE_FILE_RE = /^(LICENCE|LICENSE|COPYING|NOTICE)(\.md|\.txt|-MIT|-APACHE)?$/i;

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

// --- Rust ------------------------------------------------------------------

function rustSection() {
  try {
    return execFileSync("cargo", ["about", "generate", "about.hbs"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch (e) {
    if (e.code === "ENOENT") {
      fail(
        "`cargo about` non trovato. Installalo con:\n" +
          "      cargo install cargo-about --locked --features cli",
      );
    }
    // cargo-about exits non-zero also when it meets a licence not listed
    // in `accepted`: that is the case we want to see, not hide.
    fail("`cargo about generate` failed — see the output above.");
  }
}

// --- npm -------------------------------------------------------------------

/** Tree of production dependencies only, flattened to name@version. */
function npmProductionTree() {
  // Through a shell, not execFile: on Windows `npm` is a .cmd script, and since Node 18.20
  // execFile refuses to launch it without a shell.
  let json;
  try {
    json = execSync("npm ls --omit=dev --all --json", {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    // `npm ls` exits non-zero on unmet peer dependencies even though it
    // printed a valid tree: if there is output, use it.
    if (!e.stdout) fail(`\`npm ls\` failed with no output: ${e.message}`);
    json = e.stdout;
  }

  const found = new Map();
  (function walk(node) {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (!found.has(name) && dep.version) found.set(name, dep.version);
      walk(dep);
    }
  })(JSON.parse(json));
  return found;
}

/** Licence text stored by the package, if there is one. */
function readLicenseText(pkgDir) {
  let entries;
  try {
    entries = readdirSync(pkgDir);
  } catch {
    return null;
  }
  const files = entries.filter((f) => LICENSE_FILE_RE.test(f)).sort();
  if (files.length === 0) return null;
  return files
    .map((f) => readFileSync(join(pkgDir, f), "utf8").trim())
    .join("\n\n---\n\n");
}

function npmSection() {
  const tree = npmProductionTree();
  const missing = [];
  const blocks = [];

  for (const [name, version] of [...tree].sort(([a], [b]) => a.localeCompare(b))) {
    const pkgDir = join(ROOT, "node_modules", ...name.split("/"));
    if (!existsSync(pkgDir)) {
      missing.push(`${name}@${version} (non installato — esegui \`npm install\`)`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const spdx =
      manifest.license ??
      (Array.isArray(manifest.licenses)
        ? manifest.licenses.map((l) => l.type ?? l).join(" OR ")
        : null);
    const text = readLicenseText(pkgDir);

    if (!spdx && !text) {
      missing.push(`${name}@${version} (no \`license\` field and no licence file)`);
      continue;
    }

    blocks.push(
      `### ${name} ${version}\n\n` +
        `Licenza dichiarata: ${spdx ?? "non dichiarata nel package.json"}\n` +
        (manifest.homepage ? `Homepage: ${manifest.homepage}\n` : "") +
        (text ? `\n\`\`\`\n${text}\n\`\`\`\n` : "\n"),
    );
  }

  if (missing.length > 0) {
    // Not silenceable: a package distributed without attribution is
    // exactly the hole this file must close.
    fail(
      "production npm packages with no determinable licence:\n" +
        missing.map((m) => `      - ${m}`).join("\n"),
    );
  }
  return { body: blocks.join("\n"), count: tree.size };
}

// --- main ------------------------------------------------------------------

const appVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

console.log("  · collecting Rust licences (cargo about)…");
const rust = rustSection();
console.log("  · collecting npm licences (production dependencies)…");
const npm = npmSection();

const doc = `# Third-party notices — Pragma Symphony ${appVersion}

Generated by \`scripts/gen-third-party.mjs\` (\`npm run notices\`). **Do not edit by hand.**

Pragma Symphony includes third-party software. The licences below apply to those
components, not to Pragma Symphony: for its licence see \`LICENSE\`.

Development dependencies (build, test, tooling) are not listed: they are not distributed.

---

## Sounds

\`src/assets/ring.mp3\`, the end-of-session sound, is \`confirmation_002\` from
[Interface Sounds](https://kenney.nl/assets/interface-sounds) by Kenney (www.kenney.nl),
released under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/) and converted to MP3.

---

## Rust dependencies

${rust}

---

## JavaScript dependencies

${npm.body}
`;

writeFileSync(OUT, doc, "utf8");
console.log(`\n  ✓ THIRD-PARTY-NOTICES.md — ${npm.count} npm packages + Rust crates\n`);
