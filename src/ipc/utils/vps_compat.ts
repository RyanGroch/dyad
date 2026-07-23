import * as fs from "fs";
import * as path from "path";
import type { VpsCompat, VpsFramework } from "../types/vps";

const ENV_FILE_NAME = ".env.local";

// Env vars that mean the app talks to a database from a server it expects to
// be running. A static site has no such server, so the deploy would build
// green and then fail at runtime — the exact silent-broken case we guard.
const SERVER_DB_ENV_KEYS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL_UNPOOLED",
  "NEON_AUTH_BASE_URL",
];

const NEXT_CONFIG_FILES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
];

function detectFramework(appPath: string): VpsFramework {
  for (const file of NEXT_CONFIG_FILES) {
    if (fs.existsSync(path.join(appPath, file))) return "nextjs";
  }
  if (
    ["vite.config.js", "vite.config.ts", "vite.config.mjs"].some((f) =>
      fs.existsSync(path.join(appPath, f)),
    )
  ) {
    return "vite";
  }
  const packageJsonPath = path.join(appPath, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return "nextjs";
      if (deps.vite) return "vite";
    } catch {
      // Fall through to "other".
    }
  }
  return "other";
}

function nextHasStaticExport(appPath: string): boolean {
  for (const file of NEXT_CONFIG_FILES) {
    const configPath = path.join(appPath, file);
    if (!fs.existsSync(configPath)) continue;
    const contents = fs.readFileSync(configPath, "utf8");
    // Deliberately loose: matches output: "export" with either quote style and
    // arbitrary spacing. A false positive just lets a build fail loudly later.
    if (/output\s*:\s*["']export["']/.test(contents)) return true;
  }
  return false;
}

function hasServerDatabase(appPath: string): boolean {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(appPath, ENV_FILE_NAME), "utf8");
  } catch {
    return false;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    if (SERVER_DB_ENV_KEYS.includes(key) && value.length > 0) return true;
  }
  return false;
}

/**
 * Decides whether an app can be served by the static VPS pipeline, and with
 * what build output directory. Returns blockers (hard stops with a fix) rather
 * than letting a confidently-broken deploy through.
 */
export async function analyzeVpsCompat(appPath: string): Promise<VpsCompat> {
  const framework = detectFramework(appPath);
  const blockers: string[] = [];
  const notes: string[] = [];

  if (hasServerDatabase(appPath)) {
    blockers.push(
      "This app uses a server-side database (Neon/Postgres), which needs a " +
        "server to run. VPS deploy currently serves static sites only — use " +
        "Vercel for this app, or switch its data layer to Supabase (which " +
        "runs from the browser).",
    );
  }

  let recommendedDistDir = "dist";
  if (framework === "nextjs") {
    recommendedDistDir = "out";
    if (!nextHasStaticExport(appPath)) {
      blockers.push(
        "This Next.js app is not configured for static export. Add `output: " +
          '"export"` to next.config to deploy it as a static site, or wait for ' +
          "server-runtime support.",
      );
    } else {
      notes.push("Building Next.js as a static export.");
    }
  } else if (framework === "other") {
    notes.push(
      "Framework not recognized; assuming a static build in dist/. Adjust " +
        "distDir in dyad.deploy.json if the output goes elsewhere.",
    );
  }

  return {
    framework,
    recommendedDistDir,
    supported: blockers.length === 0,
    blockers,
    notes,
  };
}
