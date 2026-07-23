import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import log from "electron-log";
import type {
  VpsConnectionErrorKind,
  VpsDeployConfig,
  VpsTestConnectionResult,
} from "../types/vps";

const logger = log.scope("ssh_utils");

export const DEFAULT_KEY_NAME = "dyad_deploy_ed25519";

// Deploys run non-interactively, so anything that would prompt must fail or
// auto-resolve. accept-new pins the host key on first contact and rejects
// changed keys afterwards (TOFU); BatchMode prevents password prompts.
export const SSH_BASE_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "ConnectTimeout=10",
];

function sshSearchDirs(): string[] {
  if (process.platform === "win32") {
    return [
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH"),
    ];
  }
  return ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
}

function findBinary(name: string): string | null {
  const fileName = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of sshSearchDirs()) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fall back to PATH resolution; spawn will fail later if it's absent.
  return name;
}

export function isSshAvailable(): boolean {
  const fileName = process.platform === "win32" ? "ssh.exe" : "ssh";
  if (sshSearchDirs().some((dir) => fs.existsSync(path.join(dir, fileName)))) {
    return true;
  }
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  return pathDirs.some((dir) => dir && fs.existsSync(path.join(dir, fileName)));
}

export function sshKeyDir(): string {
  return path.join(os.homedir(), ".ssh");
}

export function keyFilePath(keyName: string = DEFAULT_KEY_NAME): string {
  return path.join(sshKeyDir(), keyName);
}

export function readPublicKey(
  keyName: string = DEFAULT_KEY_NAME,
): string | null {
  const pubPath = `${keyFilePath(keyName)}.pub`;
  try {
    return fs.readFileSync(pubPath, "utf8").trim();
  } catch {
    return null;
  }
}

export function deployKeyExists(keyName: string = DEFAULT_KEY_NAME): boolean {
  return fs.existsSync(keyFilePath(keyName));
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  binary: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = opts?.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Generates the dedicated deploy key if it does not exist and returns the
 * public key. The key is passphrase-less because deploys run non-interactively;
 * it is a dedicated identity, never the user's personal key.
 */
export async function ensureDeployKey(
  keyName: string = DEFAULT_KEY_NAME,
): Promise<string> {
  const keyPath = keyFilePath(keyName);
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(sshKeyDir(), { recursive: true, mode: 0o700 });
    const keygen = findBinary("ssh-keygen");
    if (!keygen) {
      throw new Error("ssh-keygen not found");
    }
    const result = await run(
      keygen,
      ["-t", "ed25519", "-N", "", "-C", "dyad-deploy", "-f", keyPath],
      { timeoutMs: 30_000 },
    );
    if (result.code !== 0) {
      throw new Error(`ssh-keygen failed: ${result.stderr.trim()}`);
    }
    logger.info(`Generated deploy key at ${keyPath}`);
  }
  const publicKey = readPublicKey(keyName);
  if (!publicKey) {
    throw new Error(`Deploy key exists but ${keyPath}.pub is unreadable`);
  }
  return publicKey;
}

/** Maps ssh's stderr to an actionable category for the connector UI. */
export function classifySshError(
  stderr: string,
  code: number | null,
): VpsConnectionErrorKind {
  const text = stderr.toLowerCase();
  if (
    text.includes("remote host identification has changed") ||
    text.includes("host key verification failed")
  ) {
    return "host-key-changed";
  }
  if (text.includes("permission denied")) {
    return "auth-rejected";
  }
  if (text.includes("timed out") || code === null) {
    return "timeout";
  }
  if (
    text.includes("could not resolve hostname") ||
    text.includes("no route to host") ||
    text.includes("connection refused") ||
    text.includes("network is unreachable")
  ) {
    return "unreachable";
  }
  return "unknown";
}

export function sshDestination(config: VpsDeployConfig): string {
  return `${config.user}@${config.host}`;
}

export function sshConnectionArgs(config: VpsDeployConfig): string[] {
  return [
    ...SSH_BASE_ARGS,
    "-p",
    String(config.port),
    "-i",
    keyFilePath(config.keyName),
    sshDestination(config),
  ];
}

export async function testConnection(
  config: VpsDeployConfig,
): Promise<VpsTestConnectionResult> {
  if (!isSshAvailable()) {
    return {
      ok: false,
      errorKind: "ssh-missing",
      error: "OpenSSH client not found on this machine",
    };
  }
  const ssh = findBinary("ssh");
  try {
    const result = await run(ssh!, [...sshConnectionArgs(config), "echo ok"], {
      timeoutMs: 20_000,
    });
    if (result.code === 0 && result.stdout.includes("ok")) {
      return { ok: true };
    }
    return {
      ok: false,
      errorKind: classifySshError(result.stderr, result.code),
      error: result.stderr.trim() || `ssh exited with code ${result.code}`,
    };
  } catch (err) {
    return {
      ok: false,
      errorKind: "unknown",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
