import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VPS_CONFIG_FILE,
  deployUrl,
  readVpsConfig,
  writeVpsConfig,
} from "./vps_config";

const VALID_CONFIG = {
  host: "203.0.113.7",
  user: "root",
  port: 22,
  remotePath: "/var/www/myapp",
  domain: null,
  keyName: "dyad_deploy_ed25519",
  distDir: "dist",
};

describe("vps_config", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vps-config-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a valid config", () => {
    writeVpsConfig(dir, VALID_CONFIG);
    expect(readVpsConfig(dir)).toEqual(VALID_CONFIG);
  });

  it("returns null when no config exists", () => {
    expect(readVpsConfig(dir)).toBeNull();
  });

  it("applies schema defaults when reading a minimal config", () => {
    writeFileSync(
      join(dir, VPS_CONFIG_FILE),
      JSON.stringify({
        host: "203.0.113.7",
        user: "deploy",
        remotePath: "/var/www/app",
      }),
    );
    const config = readVpsConfig(dir);
    expect(config?.port).toBe(22);
    expect(config?.keyName).toBe("dyad_deploy_ed25519");
    expect(config?.distDir).toBe("dist");
  });

  it("throws a descriptive error on invalid JSON", () => {
    writeFileSync(join(dir, VPS_CONFIG_FILE), "{not json");
    expect(() => readVpsConfig(dir)).toThrow(/not valid JSON/);
  });

  it("throws a descriptive error on schema violations", () => {
    writeFileSync(
      join(dir, VPS_CONFIG_FILE),
      JSON.stringify({ host: "", user: "root", remotePath: "/x" }),
    );
    expect(() => readVpsConfig(dir)).toThrow(/host/);
  });

  it("refuses to write secret-shaped keys", () => {
    expect(() =>
      writeVpsConfig(dir, {
        ...VALID_CONFIG,
        password: "hunter2",
      } as never),
    ).toThrow(/secret-like key/);
  });

  it("writes pretty-printed JSON with a trailing newline", () => {
    writeVpsConfig(dir, VALID_CONFIG);
    const raw = readFileSync(join(dir, VPS_CONFIG_FILE), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "host"');
  });

  it("builds the deploy URL from domain when set, host otherwise", () => {
    expect(deployUrl(VALID_CONFIG)).toBe("http://203.0.113.7");
    expect(deployUrl({ ...VALID_CONFIG, domain: "app.example.com" })).toBe(
      "https://app.example.com",
    );
  });
});
