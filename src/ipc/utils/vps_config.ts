import * as fs from "fs";
import * as path from "path";
import { VpsDeployConfigSchema, type VpsDeployConfig } from "../types/vps";

export const VPS_CONFIG_FILE = "dyad.deploy.json";

// dyad.deploy.json is committed to the repo, so it must never hold secrets.
// This blocklist is defense in depth against anything (including a future
// agent flow) trying to stuff credentials into it.
const SECRET_KEY_PATTERN = /pass|secret|token|credential|private/i;

export function vpsConfigPath(appPath: string): string {
  return path.join(appPath, VPS_CONFIG_FILE);
}

export function readVpsConfig(appPath: string): VpsDeployConfig | null {
  const configPath = vpsConfigPath(appPath);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${VPS_CONFIG_FILE} is not valid JSON`);
  }
  const result = VpsDeployConfigSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`${VPS_CONFIG_FILE} is invalid: ${detail}`);
  }
  return result.data;
}

export function writeVpsConfig(appPath: string, config: VpsDeployConfig): void {
  // Check the raw input: parse() strips unknown keys, which would silently
  // drop a secret instead of loudly refusing it.
  for (const key of Object.keys(config)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(
        `Refusing to write secret-like key "${key}" to ${VPS_CONFIG_FILE}`,
      );
    }
  }
  const validated = VpsDeployConfigSchema.parse(config);
  fs.writeFileSync(
    vpsConfigPath(appPath),
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8",
  );
}

export function deployUrl(config: VpsDeployConfig): string {
  return config.domain ? `https://${config.domain}` : `http://${config.host}`;
}
