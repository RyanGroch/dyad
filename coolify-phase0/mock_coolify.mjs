// Mock Coolify API + fake deployed app, used only to exercise phase0.mjs.
// Shapes mirror the real OpenAPI spec / Coolify models. Not a Coolify emulator.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8899);
const BASE = `http://127.0.0.1:${PORT}`;
const items = [];
let migrated = false;
let pollCount = 0;

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  let body = "";
  for await (const c of req) body += c;
  const parsed = body ? JSON.parse(body) : {};
  const m = req.method;

  // --- Coolify API ---
  if (p === "/api/v1/servers" && m === "GET")
    return json(res, 200, [{ name: "mock-server", uuid: "srv-1" }]);
  if (p === "/api/v1/projects" && m === "GET") return json(res, 200, []);
  if (p === "/api/v1/projects" && m === "POST")
    return json(res, 201, { uuid: "proj-1", name: parsed.name });
  if (p === "/api/v1/projects/proj-1" && m === "GET")
    return json(res, 200, { uuid: "proj-1", environments: [{ name: "production" }] });
  if (p === "/api/v1/security/keys" && m === "GET") return json(res, 200, []);
  if (p === "/api/v1/security/keys" && m === "POST")
    return json(res, 201, { uuid: "key-1" });
  if (p === "/api/v1/databases/postgresql" && m === "POST")
    return json(res, 201, { uuid: "db-1" });
  if (p === "/api/v1/databases/db-1" && m === "GET")
    return json(res, 200, {
      uuid: "db-1",
      name: "phase0-db-mock",
      status: "running:healthy",
      internal_db_url: "postgres://dyad:secret@db-1:5432/dyad",
      external_db_url: `postgres://dyad:secret@127.0.0.1:${PORT}/dyad`,
    });
  if (p === "/api/v1/databases/db-1/restart" && m === "POST") return json(res, 200, { ok: true });
  if (p === "/api/v1/applications/public" && m === "POST")
    return json(res, 201, { uuid: "app-1" });
  if (p === "/api/v1/applications/private-deploy-key" && m === "POST")
    return json(res, 201, { uuid: "app-1" });
  if (p === "/api/v1/applications/app-1/envs" && m === "POST")
    return json(res, 201, { uuid: "env-1" });
  if (p === "/api/v1/applications/app-1/start" && m === "POST")
    return json(res, 200, { deployment_uuid: "dep-1" });
  if (p === "/api/v1/applications/app-1/restart" && m === "POST")
    return json(res, 200, { deployment_uuid: "dep-2" });
  if (p === "/api/v1/deployments/applications/app-1" && m === "GET") {
    // Mirrors the real spec: returns Application objects, NOT deployments.
    return json(res, 200, [{ uuid: "app-1", name: "phase0-app-mock" }]);
  }
  if (p.startsWith("/api/v1/deployments/dep-") && m === "GET") {
    pollCount++;
    return json(res, 200, {
      deployment_uuid: "dep-1",
      status: pollCount >= 2 ? "finished" : "in_progress",
    });
  }
  if (p.startsWith("/api/v1/applications/app-1/logs") && m === "GET")
    return json(res, 200, { logs: "mock logs" });
  if (p === "/api/v1/applications/app-1" && m === "GET")
    return json(res, 200, { uuid: "app-1", fqdn: BASE });

  // --- Fake deployed app ---
  if (p === "/api/health") return json(res, 200, { ok: true, hasDatabaseUrl: true });
  if (p === "/api/migrate" && m === "POST") {
    migrated = true;
    return json(res, 200, { migrated: true });
  }
  if (p === "/api/items" && m === "POST") {
    if (!migrated) return json(res, 500, { error: "no table" });
    items.push({ id: items.length + 1, note: parsed.note });
    return json(res, 200, { inserted: items.at(-1) });
  }
  if (p === "/api/items" && m === "GET") return json(res, 200, { items });

  json(res, 404, { error: `no mock route for ${m} ${p}` });
});

server.listen(PORT, () => console.log(`mock coolify on ${BASE}`));
