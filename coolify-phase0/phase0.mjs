#!/usr/bin/env node
// Coolify Phase 0 spike: drives a full-stack deploy from a PRIVATE git repo via
// the API and reports what works. Throwaway diagnostic, not production code.
//
//   COOLIFY_URL=https://coolify.example.com \
//   COOLIFY_TOKEN=xxx \
//   TEST_REPO=git@github.com:you/coolify-phase0-testapp.git \
//   node phase0.mjs
//
// TEST_REPO must be an SSH-form URL (git@host:owner/repo.git). Deploy keys are
// SSH keys, so the https:// form will not authenticate.
//
// Requires Node 18+ and the git/ssh CLIs. No npm dependencies.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const URL_BASE = (process.env.COOLIFY_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.COOLIFY_TOKEN || "";
const TEST_REPO = process.env.TEST_REPO || "";
const TEST_BRANCH = process.env.TEST_BRANCH || "main";
const PUBLIC_DB_PORT = Number(process.env.PUBLIC_DB_PORT || 5433);
const KEY_PATH =
  process.env.DEPLOY_KEY_PATH || join(homedir(), ".ssh", "coolify_phase0_ed25519");

if (!URL_BASE || !TOKEN || !TEST_REPO) {
  console.error("Set COOLIFY_URL, COOLIFY_TOKEN, and TEST_REPO (SSH form).");
  process.exit(2);
}
if (/^https?:\/\//.test(TEST_REPO)) {
  console.error(
    `TEST_REPO must be SSH form for a private repo, e.g.\n` +
      `  git@github.com:you/coolify-phase0-testapp.git\n` +
      `got: ${TEST_REPO}`,
  );
  process.exit(2);
}

const findings = [];
function finding(question, answer, detail = "") {
  findings.push({ question, answer, detail });
  console.log(`\n  >> ${question}\n     ${answer}${detail ? `\n     ${detail}` : ""}`);
}
function step(n, msg) {
  console.log(`\n${"=".repeat(70)}\n[${n}] ${msg}\n${"=".repeat(70)}`);
}

async function api(method, path, body) {
  const res = await fetch(`${URL_BASE}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (res.status === 403 && /permission/i.test(text)) {
    throw new Error(
      `${method} ${path} -> 403: ${text.slice(0, 200)}\n\n` +
        `The API token is missing a scope. This script needs all of:\n` +
        `  read             list servers/projects/applications\n` +
        `  read:sensitive   read the database connection strings\n` +
        `  write            create projects, databases, apps, env vars, keys\n` +
        `  deploy           trigger deployments and restarts\n` +
        `Scopes are fixed when a token is created, so make a NEW token\n` +
        `(Coolify UI -> Keys & Tokens -> API tokens) with all four, or 'root'.`,
    );
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

// PHASE0_SPEED>1 shortens waits; used to exercise this script against a mock.
const SPEED = Number(process.env.PHASE0_SPEED || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(1, ms / SPEED)));

const SSH_OPTS = `-i ${KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;

function ensureLocalKey() {
  if (existsSync(KEY_PATH)) return false;
  mkdirSync(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  execFileSync("ssh-keygen", [
    "-t", "ed25519",
    "-N", "",
    "-C", "coolify-phase0",
    "-f", KEY_PATH,
  ]);
  return true;
}

function repoAccessible() {
  try {
    execFileSync("git", ["ls-remote", TEST_REPO, "HEAD"], {
      env: { ...process.env, GIT_SSH_COMMAND: `ssh ${SSH_OPTS}` },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

// CLEANUP=1 deletes the phase0 app + database so the next run starts fresh.
async function cleanup() {
  console.log("CLEANUP: deleting phase0 resources...");
  for (const [kind, path] of [
    ["applications", "/applications"],
    ["databases", "/databases"],
  ]) {
    const all = await api("GET", path).catch(() => []);
    for (const r of Array.isArray(all) ? all : []) {
      if (!String(r.name || "").startsWith(`phase0-${kind === "applications" ? "app" : "db"}-`))
        continue;
      await api("DELETE", `${path}/${r.uuid}`).catch((e) =>
        console.log(`  failed to delete ${r.name}: ${e.message.slice(0, 100)}`),
      );
      console.log(`  deleted ${kind.slice(0, -1)} ${r.name}`);
    }
  }
  console.log("CLEANUP done.");
}

async function main() {
  const stamp = Date.now().toString(36);
  let dbUuid, appUuid, appUrl, internalDbUrl, externalDbUrl;

  if (process.env.CLEANUP === "1") {
    await cleanup();
    return;
  }

  step(1, "Validate token + discover server/project/environment");
  const servers = await api("GET", "/servers");
  console.log(`servers: ${servers.map((s) => `${s.name}(${s.uuid})`).join(", ")}`);
  const server = servers[0];
  if (!server) throw new Error("No servers found");

  const projects = await api("GET", "/projects");
  let project = projects.find((p) => p.name === "dyad-phase0");
  if (!project) {
    project = await api("POST", "/projects", {
      name: "dyad-phase0",
      description: "Dyad Coolify spike",
    });
    console.log(`created project ${project.uuid}`);
  }
  const projectDetail = await api("GET", `/projects/${project.uuid}`);
  const envName = projectDetail.environments?.[0]?.name || "production";
  finding(
    "Can Dyad discover servers/projects/environments via API?",
    "YES",
    `server=${server.uuid} project=${project.uuid} env=${envName}`,
  );

  step(2, "Deploy key: ensure it exists locally and grants access to the PRIVATE repo");
  const created = ensureLocalKey();
  const publicKey = readFileSync(`${KEY_PATH}.pub`, "utf8").trim();
  console.log(`${created ? "generated" : "reusing"} key: ${KEY_PATH}`);

  if (!repoAccessible()) {
    console.log(`\n${"!".repeat(70)}`);
    console.log("This key cannot read the repo yet. Add it as a DEPLOY KEY:\n");
    console.log(publicKey);
    console.log(`\nGitHub:  repo -> Settings -> Deploy keys -> Add deploy key`);
    console.log(`  or:    gh repo deploy-key add ${KEY_PATH}.pub -R <owner>/<repo>`);
    console.log(`GitLab:  repo -> Settings -> Repository -> Deploy keys`);
    console.log(`Gitea:   repo -> Settings -> Deploy Keys`);
    console.log(`\nRead-only access is enough. Then re-run this script.`);
    console.log(`${"!".repeat(70)}`);
    finding(
      "Does a deploy key grant access to the private repo?",
      "NOT YET - key needs to be added to the repo",
      "Script stopped before creating any Coolify resources.",
    );
    return summarize({});
  }
  finding(
    "Does a deploy key grant access to the private repo?",
    "YES",
    "Verified with git ls-remote before touching Coolify. No GitHub App needed; " +
      "works with any SSH-reachable git host (GitHub/GitLab/Gitea/self-hosted).",
  );

  step(3, "Register the private key with Coolify (POST /security/keys)");
  const existingKeys = await api("GET", "/security/keys").catch(() => []);
  const keyName = "dyad-phase0";
  let privateKeyUuid = (Array.isArray(existingKeys) ? existingKeys : []).find(
    (k) => k.name === keyName,
  )?.uuid;
  if (!privateKeyUuid) {
    const reg = await api("POST", "/security/keys", {
      name: keyName,
      description: "Dyad Coolify phase 0 spike",
      private_key: readFileSync(KEY_PATH, "utf8"),
    });
    privateKeyUuid = reg.uuid;
  }
  finding(
    "Can Dyad register a deploy key via API (no UI step)?",
    privateKeyUuid ? "YES" : "NO",
    `private_key_uuid=${privateKeyUuid}`,
  );

  step(4, "Create Postgres (public port ON, to test migration reachability)");
  // Re-runnable: a leftover phase0 database still holds the public port, so
  // reuse it rather than colliding with "Public port already used".
  const allDbs = await api("GET", "/databases").catch(() => []);
  const existingDb = (Array.isArray(allDbs) ? allDbs : []).find((d) =>
    String(d.name || "").startsWith("phase0-db-"),
  );
  if (existingDb) {
    dbUuid = existingDb.uuid;
    console.log(`reusing existing database ${existingDb.name} (${dbUuid})`);
  } else {
    const db = await api("POST", "/databases/postgresql", {
      server_uuid: server.uuid,
      project_uuid: project.uuid,
      environment_name: envName,
      name: `phase0-db-${stamp}`,
      postgres_user: "dyad",
      postgres_db: "dyad",
      is_public: true,
      public_port: PUBLIC_DB_PORT,
      instant_deploy: true,
    });
    dbUuid = db.uuid;
    console.log(`db uuid: ${dbUuid}`);
  }

  step(5, "Wait for the database to actually start, then read connection strings");
  // The container takes time to come up. Checking too early makes the port
  // look closed when it simply is not listening yet.
  let dbDetail = {};
  let statusReported = false;
  const dbWaitStart = Date.now();
  const dbMaxWait = (3 * 60 * 1000) / SPEED;
  let blankPolls = 0;
  while (Date.now() - dbWaitStart < dbMaxWait) {
    dbDetail = await api("GET", `/databases/${dbUuid}`);
    const st = String(dbDetail.status || "");
    console.log(`  db status: ${st || "(not reported)"}`);
    if (st) {
      statusReported = true;
      if (st.startsWith("running")) break;
    } else if (++blankPolls >= 3) {
      // This Coolify build does not surface a status field; don't burn the
      // full timeout waiting for something that will never appear.
      break;
    }
    await sleep(10000);
  }
  finding(
    "Does the database reach a running state?",
    !statusReported
      ? "UNKNOWN - API did not report a status field"
      : String(dbDetail.status || "").startsWith("running")
        ? `YES (${dbDetail.status})`
        : `NO - stuck at '${dbDetail.status}'`,
    `waited ${Math.round((Date.now() - dbWaitStart) / 1000)}s`,
  );
  internalDbUrl = dbDetail.internal_db_url;
  externalDbUrl = dbDetail.external_db_url;
  const mask = (u) => (u ? u.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:****@") : String(u));
  console.log(`internal: ${mask(internalDbUrl)}`);
  console.log(`external: ${mask(externalDbUrl)}`);
  finding(
    "Does the API expose the DB connection string?",
    internalDbUrl ? "YES (internal_db_url present)" : "NO - check token has read:sensitive",
    "internal host is the DB container UUID, only resolvable inside Coolify's docker network",
  );
  finding(
    "Can Dyad reach the DB externally to run migrations?",
    externalDbUrl ? "YES, but only because is_public=true was set" : "NO (external_db_url null)",
    "external_db_url is null unless is_public && public_port. This is the migration-connectivity decision.",
  );

  step(6, "Test raw TCP reachability of the public DB port (with retries)");
  if (externalDbUrl) {
    const m = externalDbUrl.match(/@([^:]+):(\d+)\//);
    const [, host, port] = m || [];
    const net = await import("node:net");
    const probe = () =>
      new Promise((resolve) => {
        const sock = net.createConnection({ host, port: Number(port) });
        const done = (v) => {
          sock.destroy();
          resolve(v);
        };
        sock.setTimeout(8000);
        sock.on("connect", () => done(true));
        sock.on("timeout", () => done(false));
        sock.on("error", () => done(false));
      });
    // Retry: the port binding can lag the container reporting "running".
    let reachable = false;
    for (let i = 0; i < 6 && !reachable; i++) {
      reachable = await probe();
      if (!reachable) {
        console.log(`  not reachable yet, retrying (${i + 1}/6)...`);
        await sleep(10000);
      }
    }
    finding(
      `Is the public DB port actually open from outside (${host}:${port})?`,
      reachable ? "YES" : "NO - firewall or port not bound",
      reachable
        ? "Dyad could run migrations directly against this."
        : "Check the provider firewall before concluding Coolify can't do it.",
    );
  }

  step(7, "Create the application from the PRIVATE repo (deploy key + nixpacks)");
  const allApps = await api("GET", "/applications").catch(() => []);
  const existingApp = (Array.isArray(allApps) ? allApps : []).find((a) =>
    String(a.name || "").startsWith("phase0-app-"),
  );
  let app;
  if (existingApp) {
    console.log(`reusing existing app ${existingApp.name} (${existingApp.uuid})`);
    app = existingApp;
  } else {
    app = await api("POST", "/applications/private-deploy-key", {
      project_uuid: project.uuid,
      server_uuid: server.uuid,
      environment_name: envName,
      private_key_uuid: privateKeyUuid,
      git_repository: TEST_REPO,
      git_branch: TEST_BRANCH,
      build_pack: "nixpacks",
      name: `phase0-app-${stamp}`,
      ports_exposes: "3000",
      autogenerate_domain: true,
      health_check_enabled: true,
      health_check_path: "/api/health",
      health_check_port: "3000",
      instant_deploy: false,
    });
  }
  appUuid = app.uuid;
  finding(
    "Can Dyad create an app from a PRIVATE repo via API?",
    appUuid ? "YES" : "NO",
    `app uuid: ${appUuid}${existingApp ? " (reused)" : ""}`,
  );

  step(8, "Inject DATABASE_URL (the internal URL; app runs on the same network)");
  // Valid fields are key/value/is_preview/is_literal/is_multiline/
  // is_shown_once. is_literal stops Coolify interpolating a '$' that may
  // appear in the generated password. On a reused app the key already
  // exists, so fall back to PATCH.
  const envBody = {
    key: "DATABASE_URL",
    value: internalDbUrl,
    is_preview: false,
    is_literal: true,
  };
  try {
    await api("POST", `/applications/${appUuid}/envs`, envBody);
  } catch (e) {
    console.log(`  POST failed (${e.message.slice(0, 90)}), trying PATCH...`);
    await api("PATCH", `/applications/${appUuid}/envs`, envBody);
  }
  finding("Can Dyad wire the DB into the app via API?", "YES", "POST /applications/{uuid}/envs");

  step(9, "Deploy and poll status");
  const deployRes = await api("POST", `/applications/${appUuid}/start`, {});
  console.log("deploy trigger:", JSON.stringify(deployRes).slice(0, 300));
  const deploymentUuid =
    deployRes.deployment_uuid || deployRes.deployments?.[0]?.deployment_uuid;
  console.log(`deployment uuid: ${deploymentUuid || "(none returned)"}`);

  // Poll GET /deployments/{uuid}: it returns the deployment queue entry with a
  // real status. NOT /deployments/applications/{uuid} — despite the name, that
  // returns Application objects, which have no deployment status field.
  let status = "unknown";
  const started = Date.now();
  const deployMaxWait = (15 * 60 * 1000) / SPEED;
  while (Date.now() - started < deployMaxWait) {
    await sleep(10000);
    try {
      let entry;
      if (deploymentUuid) {
        entry = await api("GET", `/deployments/${deploymentUuid}`);
      } else {
        const all = await api("GET", "/deployments");
        entry = (Array.isArray(all) ? all : []).find(
          (d) => d.application_id === appUuid || d.application_name?.startsWith("phase0-app-"),
        );
      }
      status = entry?.status || "unknown";
      console.log(`  status: ${status} (${Math.round((Date.now() - started) / 1000)}s)`);
      if (["finished", "failed", "cancelled-by-user", "error"].includes(status)) break;
    } catch (e) {
      console.log("  poll error:", e.message.slice(0, 120));
    }
  }
  if (status !== "finished") {
    // Surface why, rather than leaving a bare status string.
    const logs = await api("GET", `/applications/${appUuid}/logs?lines=40`).catch(
      () => null,
    );
    if (logs) console.log("\n--- recent app logs ---\n", JSON.stringify(logs).slice(0, 1500));
  }
  finding(
    "Can Dyad poll deployment status?",
    status === "finished" ? "YES - reached 'finished'" : `ENDED AS '${status}'`,
    `build took ~${Math.round((Date.now() - started) / 1000)}s. If it failed here, check ` +
      `the build logs: GET /applications/${appUuid}/logs`,
  );

  step(10, "Resolve the app URL");
  const appDetail = await api("GET", `/applications/${appUuid}`);
  appUrl = (appDetail.fqdn || "").split(",")[0];
  finding(
    "Does the app get a working URL with no DNS setup?",
    appUrl ? `YES: ${appUrl}` : "NO - no fqdn assigned",
    "autogenerate_domain uses the server wildcard domain or sslip.io fallback",
  );

  if (!appUrl || status !== "finished") {
    console.log("\nStopping before app checks (deploy did not succeed).");
    return summarize({ dbUuid, appUuid, appUrl });
  }

  step(11, "Functional check: health, migrate, write, read");
  const hit = async (path, init) => {
    const r = await fetch(`${appUrl}${path}`, init);
    const t = await r.text();
    return { ok: r.ok, status: r.status, body: t.slice(0, 300) };
  };
  await sleep(5000);
  console.log("health:", JSON.stringify(await hit("/api/health")));
  console.log("migrate:", JSON.stringify(await hit("/api/migrate", { method: "POST" })));
  const wrote = await hit("/api/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note: `phase0-${stamp}` }),
  });
  console.log("write:", JSON.stringify(wrote));
  const read = await hit("/api/items");
  console.log("read:", JSON.stringify(read));
  finding(
    "Does the deployed app reach Postgres over the internal network?",
    read.ok && read.body.includes(stamp) ? "YES" : "NO",
    `read body: ${read.body.slice(0, 160)}`,
  );

  step(12, "THE IMPORTANT ONE: does data survive a redeploy?");
  await api("POST", `/applications/${appUuid}/restart`, {});
  console.log("redeploy triggered; waiting...");
  await sleep(45000);
  for (let i = 0; i < 20; i++) {
    const h = await hit("/api/health").catch(() => ({ ok: false }));
    if (h.ok) break;
    await sleep(10000);
  }
  const afterRedeploy = await hit("/api/items");
  finding(
    "Does DB data survive an app redeploy?",
    afterRedeploy.ok && afterRedeploy.body.includes(stamp) ? "YES" : "NO - DATA LOST",
    `body: ${afterRedeploy.body.slice(0, 160)}`,
  );

  step(13, "Restart the DATABASE and re-check persistence (volume test)");
  await api("POST", `/databases/${dbUuid}/restart`, {});
  await sleep(30000);
  let afterDbRestart = { ok: false, body: "" };
  for (let i = 0; i < 20; i++) {
    afterDbRestart = await hit("/api/items").catch(() => ({ ok: false, body: "" }));
    if (afterDbRestart.ok) break;
    await sleep(10000);
  }
  finding(
    "Does DB data survive a database restart? (volume persistence)",
    afterDbRestart.ok && afterDbRestart.body.includes(stamp) ? "YES" : "NO - DATA LOST",
    `body: ${afterDbRestart.body.slice(0, 160)}`,
  );

  summarize({ dbUuid, appUuid, appUrl });
}

function summarize(ctx) {
  console.log(`\n\n${"#".repeat(70)}\n# PHASE 0 FINDINGS\n${"#".repeat(70)}`);
  for (const f of findings) {
    console.log(`\n- ${f.question}\n  ANSWER: ${f.answer}`);
    if (f.detail) console.log(`  ${f.detail}`);
  }
  if (ctx.dbUuid || ctx.appUuid) {
    console.log(`\n\nCreated resources (delete when done):`);
    if (ctx.dbUuid) console.log(`  DELETE /api/v1/databases/${ctx.dbUuid}`);
    if (ctx.appUuid) console.log(`  DELETE /api/v1/applications/${ctx.appUuid}`);
    console.log(`  app url: ${ctx.appUrl || "n/a"}`);
  }
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  summarize({});
  process.exit(1);
});
