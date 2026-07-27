import { describe, expect, it } from "vitest";
import { getPortablePostgresSystemPrompt } from "./portable_postgres_prompt";

describe("getPortablePostgresSystemPrompt", () => {
  const nextjs = getPortablePostgresSystemPrompt("nextjs");
  const other = getPortablePostgresSystemPrompt("vite");

  it("forbids every provider-specific client", () => {
    for (const banned of [
      "@neondatabase/serverless",
      "@neondatabase/auth",
      "@supabase/supabase-js",
    ]) {
      expect(nextjs).toContain(banned);
    }
    expect(nextjs).toMatch(/NEVER install or import/);
  });

  it("forbids provider auth and provider RLS helpers", () => {
    expect(nextjs).toMatch(/no-vendor-auth/);
    expect(nextjs).toMatch(/auth\.user_id\(\)/);
  });

  it("keeps the connection string off the client", () => {
    expect(nextjs).toMatch(/no-db-url-client-side/);
    expect(nextjs).toMatch(/"use client"/);
  });

  it("derives TLS from the connection string so one path serves both databases", () => {
    // Managed Postgres requires TLS; a self-hosted one usually has none.
    expect(nextjs).toContain("sslmode");
    expect(nextjs).toContain("rejectUnauthorized");
  });

  it("tells non-Next apps to bind the provided port and interface", () => {
    expect(other).toContain("process.env.PORT");
    expect(other).toContain("0.0.0.0");
  });

  it("routes schema changes through the existing execute-sql tag", () => {
    expect(nextjs).toContain("<dyad-execute-sql>");
  });

  it("uses parameterised queries in its examples", () => {
    expect(nextjs).toContain("$1");
    expect(nextjs).toMatch(/Never build SQL by concatenating user input/i);
  });
});
