import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeVpsCompat } from "./vps_compat";

describe("analyzeVpsCompat", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vps-compat-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePackageJson(deps: Record<string, string>) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: deps }),
    );
  }

  it("supports a Vite app and recommends dist", async () => {
    writeFileSync(join(dir, "vite.config.ts"), "export default {}");
    writePackageJson({ vite: "^5", react: "^18" });
    const compat = await analyzeVpsCompat(dir);
    expect(compat).toMatchObject({
      framework: "vite",
      recommendedDistDir: "dist",
      supported: true,
      blockers: [],
    });
  });

  it("supports a Vite + Supabase app (client-side keys, no server DB)", async () => {
    writeFileSync(join(dir, "vite.config.ts"), "export default {}");
    writePackageJson({ vite: "^5", "@supabase/supabase-js": "^2" });
    // Supabase config is baked into source, not a server DB secret.
    writeFileSync(join(dir, ".env.local"), "SOME_PUBLIC_FLAG=true\n");
    const compat = await analyzeVpsCompat(dir);
    expect(compat.supported).toBe(true);
  });

  it("blocks an app with a server-side database (Neon/Postgres)", async () => {
    writeFileSync(join(dir, "vite.config.ts"), "export default {}");
    writePackageJson({ vite: "^5" });
    writeFileSync(
      join(dir, ".env.local"),
      "DATABASE_URL=postgres://user:pass@ep-neon.example/db\n",
    );
    const compat = await analyzeVpsCompat(dir);
    expect(compat.supported).toBe(false);
    expect(compat.blockers.join(" ")).toMatch(/server-side database/i);
  });

  it("ignores an empty server-DB env value", async () => {
    writeFileSync(join(dir, "vite.config.ts"), "export default {}");
    writePackageJson({ vite: "^5" });
    writeFileSync(join(dir, ".env.local"), "DATABASE_URL=\n");
    const compat = await analyzeVpsCompat(dir);
    expect(compat.supported).toBe(true);
  });

  it("blocks a Next app without static export and recommends out", async () => {
    writeFileSync(join(dir, "next.config.js"), "module.exports = {}");
    writePackageJson({ next: "^15" });
    const compat = await analyzeVpsCompat(dir);
    expect(compat.framework).toBe("nextjs");
    expect(compat.recommendedDistDir).toBe("out");
    expect(compat.supported).toBe(false);
    expect(compat.blockers.join(" ")).toMatch(/static export/i);
  });

  it("supports a Next app configured for static export", async () => {
    writeFileSync(
      join(dir, "next.config.js"),
      'module.exports = { output: "export" }',
    );
    writePackageJson({ next: "^15" });
    const compat = await analyzeVpsCompat(dir);
    expect(compat.supported).toBe(true);
    expect(compat.recommendedDistDir).toBe("out");
  });

  it("matches single-quoted output: 'export' too", async () => {
    writeFileSync(
      join(dir, "next.config.mjs"),
      "const cfg = { output: 'export' };\nexport default cfg;",
    );
    writePackageJson({ next: "^15" });
    const compat = await analyzeVpsCompat(dir);
    expect(compat.supported).toBe(true);
  });

  it("does not treat a commented-out output:export as configured", async () => {
    writeFileSync(
      join(dir, "next.config.js"),
      "// output: 'export'\nmodule.exports = {}",
    );
    writePackageJson({ next: "^15" });
    const compat = await analyzeVpsCompat(dir);
    expect(compat.supported).toBe(false);
    expect(compat.blockers.join(" ")).toMatch(/static export/i);
  });

  it("falls back to other/dist with a note for unknown frameworks", async () => {
    writePackageJson({ "some-static-gen": "^1" });
    const compat = await analyzeVpsCompat(dir);
    expect(compat.framework).toBe("other");
    expect(compat.recommendedDistDir).toBe("dist");
    expect(compat.supported).toBe(true);
    expect(compat.notes.length).toBeGreaterThan(0);
  });
});
