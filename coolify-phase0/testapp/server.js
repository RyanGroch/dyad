// Minimal full-stack test app for the Coolify Phase 0 spike.
// Exercises: server runtime, DATABASE_URL injection, schema creation,
// write + read, and (via redeploy) data persistence.
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Coolify's internal Postgres is plain TCP on the docker network.
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    // Masked: proves injection worked without leaking the password.
    dbHost: (process.env.DATABASE_URL || "").replace(/:\/\/([^:]+):([^@]+)@/, "://$1:****@"),
    uptime: process.uptime(),
  });
});

app.post("/api/migrate", async (_req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        note TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    res.json({ migrated: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
});

app.get("/api/items", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, note, created_at FROM items ORDER BY id DESC LIMIT 50",
    );
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
});

app.post("/api/items", async (req, res) => {
  try {
    const note = String(req.body?.note ?? "unnamed");
    const { rows } = await pool.query(
      "INSERT INTO items (note) VALUES ($1) RETURNING id, note, created_at",
      [note],
    );
    res.json({ inserted: rows[0] });
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
});

app.get("/", (_req, res) => {
  res.type("html").send(
    "<h1>Coolify Phase 0 test app</h1><p>See /api/health and /api/items</p>",
  );
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => console.log(`listening on ${port}`));
