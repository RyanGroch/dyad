// TEMPORARY (fork test branch only): checks the packaged app after a source map upload build.
import fs from "node:fs";
import path from "node:path";
import asar from "@electron/asar";

function findAsar(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === "app.asar") return full;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const found = findAsar(full);
      if (found) return found;
    }
  }
  return undefined;
}

if (!fs.existsSync("out")) {
  console.error("FAIL: out/ does not exist (the build crashed, likely out of memory)");
  process.exit(1);
}
const archive = findAsar("out");
if (!archive) {
  console.error("FAIL: no app.asar under out/");
  process.exit(1);
}
console.log(`asar: ${archive}`);

// Normalize names for matching, but extract with the archive's own (Windows: backslash) names.
const originalName = new Map();
const files = asar.listPackage(archive).map((raw) => {
  const name = raw.replace(/\\/g, "/").replace(/^\//, "");
  originalName.set(name, raw.replace(/^[\\/]/, ""));
  return name;
});
const failures = [];
// Only Dyad's own bundles; some npm packages ship their own .map files (pre-existing).
const maps = files.filter((f) => f.startsWith(".vite/") && f.endsWith(".map"));
if (maps.length) failures.push(`.map files shipped: ${maps.join(", ")}`);

const bundles = files.filter((f) => f.startsWith(".vite/") && f.endsWith(".js"));
const mainBundle = bundles.find((f) => /^\.vite\/build\/main-[^/]+\.js$/.test(f));
const rendererEntry = bundles.find((f) =>
  /^\.vite\/renderer\/main_window\/assets\/index-[^/]+\.js$/.test(f),
);
if (!mainBundle) failures.push("main bundle not found");
if (!rendererEntry) failures.push("renderer entry bundle not found");
const mustHaveChunkId = [mainBundle, ".vite/build/preload.js", rendererEntry].filter(Boolean);

// Every staged bundle must be byte-identical to the shipped one, with its map beside it.
const stagingRoot = process.env.POSTHOG_SOURCEMAPS_DIR;
const stagedTargets = stagingRoot ? fs.readdirSync(stagingRoot) : [];
if (stagedTargets.length !== 1) failures.push(`expected one staged target, got ${stagedTargets}`);
const stagedDir = path.join(stagingRoot ?? "", stagedTargets[0] ?? "");

let withChunkId = 0;
let staged = 0;
for (const file of bundles) {
  const text = asar.extractFile(archive, originalName.get(file)).toString("utf8");
  const hasChunkId = /\/\/# chunkId=/.test(text);
  if (hasChunkId) withChunkId++;
  if (hasChunkId) {
    const rel = file.slice(".vite/".length);
    const stagedBundle = path.join(stagedDir, rel);
    if (!fs.existsSync(stagedBundle) || fs.readFileSync(stagedBundle, "utf8") !== text) {
      failures.push(`${file} not staged or differs from the shipped bundle`);
    } else {
      staged++;
      const id = text.match(/\/\/# chunkId=(\S+)/)[1];
      const map = JSON.parse(fs.readFileSync(`${stagedBundle}.map`, "utf8"));
      if (map.chunk_id !== id) failures.push(`${file}: map chunk_id ${map.chunk_id} != ${id}`);
    }
  }
  // Main-process bundles must still start with their "use strict" directive.
  if (file.startsWith(".vite/build/") && !/^["']use strict["'];/.test(text)) {
    failures.push(`${file} no longer starts with "use strict"`);
  }
  if (/sourceMappingURL=/.test(text)) failures.push(`${file} still has a sourceMappingURL comment`);
  if (mustHaveChunkId.includes(file) && !hasChunkId) failures.push(`${file} has no chunkId`);
  if (mustHaveChunkId.includes(file) && hasChunkId) {
    console.log(`chunkId ${file}: ${text.match(/\/\/# chunkId=(\S+)/)[1]}`);
  }
}
for (const file of mustHaveChunkId) {
  if (!bundles.includes(file)) failures.push(`${file} missing from asar`);
}

console.log(`${bundles.length} bundles, ${withChunkId} with chunk IDs, ${staged} staged, ${maps.length} .map files`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("OK");
