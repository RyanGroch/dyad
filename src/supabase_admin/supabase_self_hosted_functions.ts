import { randomBytes } from "node:crypto";
import log from "electron-log";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import {
  connectSsh,
  expectFingerprint,
  SshError,
  trustOnFirstUse,
  type SshResult,
  type SshSession,
} from "@/ipc/utils/ssh_client";
import type { SupabaseSelfHostedSsh } from "./supabase_self_hosted_store";
import { supabaseSelfHostedAuthHeaders } from "./supabase_self_hosted_client";
import { SUPABASE_SELF_HOSTED_COMMAND_ERROR_NAME } from "@/shared/supabase_self_hosted_error_names";

const logger = log.scope("supabase_self_hosted_functions");

/**
 * Where the edge runtime reads functions from, in both the upstream Docker
 * Compose install and the Coolify template. `main` there is the router that
 * serves every other function.
 */
const FUNCTIONS_DIR = "/home/deno/functions";
const ROUTER_FUNCTION = "main";
const SHARED_DIR = "_shared";

const COMMAND_TIMEOUT_MS = 60_000;
const PROBE_REQUEST_TIMEOUT_MS = 30_000;
/** A pooled connection is closed after this long without a command. */
const SESSION_IDLE_MS = 30_000;
const LOG_LINE_LIMIT = 5_000;

const FUNCTION_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const EDGE_RUNTIME_IMAGE = /(^|\/)edge-runtime(:|@|$)/;

export interface SupabaseSelfHostedFunctionFile {
  /** `<function>/...` or `_shared/...`, with forward slashes. */
  relativePath: string;
  content: Uint8Array;
}

export interface SupabaseSelfHostedFunctionLog {
  timestamp: number;
  level: "info" | "warn" | "error";
  message: string;
}

interface InstanceWithSsh {
  id: string;
  ssh: SupabaseSelfHostedSsh;
}

// ─────────────────────────────────────────────────────────────────────
// Connections
// ─────────────────────────────────────────────────────────────────────

interface PooledSession {
  session: Promise<SshSession>;
  users: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * One SSH connection per instance, shared by deploys and the preview's log
 * polling, so a poll every few seconds does not open a connection each time.
 */
const sessions = new Map<string, PooledSession>();

function dropSession(instanceId: string, entry: PooledSession) {
  if (sessions.get(instanceId) === entry) sessions.delete(instanceId);
  clearTimeout(entry.idleTimer);
  entry.session.then((session) => session.end()).catch(() => {});
}

async function openSession(ssh: SupabaseSelfHostedSsh): Promise<SshSession> {
  try {
    return await connectSsh(
      {
        host: ssh.host,
        port: ssh.port,
        username: ssh.username,
        privateKey: ssh.privateKey,
      },
      expectFingerprint(ssh.hostKeyFingerprint),
    );
  } catch (error) {
    if (error instanceof SshError && error.failure === "host-key-rejected") {
      throw new DyadError(
        "This server's SSH host key changed since the instance was added, so Dyad did not send it anything. If you rebuilt the server, remove the instance and add it again.",
        DyadErrorKind.Precondition,
      );
    }
    throw error;
  }
}

/** A failure that leaves the connection unusable, rather than one command. */
function isConnectionFailure(error: unknown): boolean {
  return error instanceof SshError && error.failure !== "command-timeout";
}

async function withSession<T>(
  instance: InstanceWithSsh,
  operation: (session: SshSession) => Promise<T>,
): Promise<T> {
  let entry = sessions.get(instance.id);
  const reused = entry !== undefined;
  if (!entry) {
    entry = { session: openSession(instance.ssh), users: 0 };
    sessions.set(instance.id, entry);
  }
  const current = entry;
  current.users++;
  clearTimeout(current.idleTimer);
  try {
    let session: SshSession;
    try {
      session = await current.session;
    } catch (error) {
      // A connection that never opened is not kept for the next caller.
      dropSession(instance.id, current);
      throw error;
    }
    return await operation(session);
  } catch (error) {
    if (!isConnectionFailure(error)) throw error;
    dropSession(instance.id, current);
    // A pooled connection the server has since closed fails on first use.
    // Every operation here is safe to repeat, so try once on a fresh one.
    if (!reused) throw error;
    return withSession(instance, operation);
  } finally {
    current.users--;
    if (current.users === 0 && sessions.get(instance.id) === current) {
      current.idleTimer = setTimeout(
        () => dropSession(instance.id, current),
        SESSION_IDLE_MS,
      );
      current.idleTimer.unref?.();
    }
  }
}

/** A server command that failed. Its output can name the user's paths and hosts. */
export class SupabaseSelfHostedCommandError extends DyadError {
  constructor(message: string, kind: DyadErrorKind) {
    super(message, kind);
    this.name = SUPABASE_SELF_HOSTED_COMMAND_ERROR_NAME;
  }
}

function commandError(action: string, result: SshResult): DyadError {
  const output = `${result.stderr}\n${result.stdout}`.trim().slice(-600);
  if (/permission denied.*docker/i.test(output)) {
    return new DyadError(
      `Could not ${action}: the SSH user isn't allowed to run docker. Connect as root, or add the user to the docker group (usermod -aG docker <user>).`,
      DyadErrorKind.Precondition,
    );
  }
  if (/docker: (command )?not found/i.test(output)) {
    return new DyadError(
      `Could not ${action}: docker isn't installed for the SSH user.`,
      DyadErrorKind.Precondition,
    );
  }
  if (/no such container/i.test(output)) {
    return new DyadError(
      `Could not ${action}: the edge functions container Dyad found when the instance was added no longer exists. Remove the instance and add it again.`,
      DyadErrorKind.Precondition,
    );
  }
  return new SupabaseSelfHostedCommandError(
    `Could not ${action} (exit ${result.code ?? result.signal}): ${output || "no output"}`,
    DyadErrorKind.External,
  );
}

async function run(
  session: SshSession,
  action: string,
  command: string,
  options: { input?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const result = await session.run(command, {
    ...options,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (result.code !== 0) throw commandError(action, result);
  return result.stdout;
}

// ─────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────

function assertFunctionName(name: string): void {
  if (!FUNCTION_NAME.test(name) || name === ROUTER_FUNCTION) {
    throw new DyadError(
      name === ROUTER_FUNCTION
        ? `A function can't be named "${ROUTER_FUNCTION}" on a self-hosted instance: that name is the router that serves every other function.`
        : `"${name}" isn't a valid edge function name.`,
      DyadErrorKind.Validation,
    );
  }
}

function assertContainerName(name: string): void {
  if (!CONTAINER_NAME.test(name)) {
    throw new DyadError(
      `"${name}" isn't a valid container name.`,
      DyadErrorKind.Validation,
    );
  }
}

/**
 * The shell command that replaces one function's directory with the archive
 * on stdin and merges its shared files.
 *
 * The new directory is unpacked beside the old one and moved into place, so
 * a failed upload leaves the deployed function as it was. `_shared` is merged
 * rather than replaced: other apps on the instance may keep files there.
 * Names are validated before they get here and the script has no single
 * quotes, so it can sit inside one quoted argument.
 */
export function deployCommand(container: string, functionName: string): string {
  const stage = `.dyad-stage-${randomBytes(6).toString("hex")}`;
  const script = [
    "set -eu",
    `cd ${FUNCTIONS_DIR}`,
    `trap "rm -rf ${stage}" EXIT`,
    `mkdir ${stage}`,
    `tar -x -C ${stage}`,
    `if [ -d ${stage}/${SHARED_DIR} ]; then mkdir -p ${SHARED_DIR} && cp -R ${stage}/${SHARED_DIR}/. ${SHARED_DIR}/; fi`,
    `if [ -e ${functionName} ]; then mv ${functionName} ${stage}/previous; fi`,
    `mv ${stage}/${functionName} ${functionName}`,
  ].join("\n");
  return `base64 -d | docker exec -i ${container} sh -c '${script}'`;
}

export async function deploySupabaseSelfHostedFunction({
  instance,
  functionName,
  files,
  signal,
}: {
  instance: InstanceWithSsh;
  functionName: string;
  files: readonly SupabaseSelfHostedFunctionFile[];
  signal?: AbortSignal;
}): Promise<void> {
  assertFunctionName(functionName);
  const container = instance.ssh.functionsContainer;
  assertContainerName(container);
  for (const file of files) {
    const segments = file.relativePath.split("/");
    const root = segments[0];
    if (
      (root !== functionName && root !== SHARED_DIR) ||
      segments.length < 2 ||
      segments.some((segment) => segment === "" || segment === "..")
    ) {
      throw new DyadError(
        `Refusing to upload ${file.relativePath} outside the function's directory.`,
        DyadErrorKind.Validation,
      );
    }
  }
  if (!files.some((file) => file.relativePath.startsWith(`${functionName}/`))) {
    throw new DyadError(
      `Supabase function ${functionName} has no files to deploy.`,
      DyadErrorKind.Validation,
    );
  }
  const archive = Buffer.from(createTarArchive(files)).toString("base64");
  await withSession(instance, (session) =>
    run(
      session,
      `deploy ${functionName}`,
      deployCommand(container, functionName),
      { input: archive, signal },
    ),
  );
  logger.info(
    `Deployed ${functionName} to self-hosted instance ${instance.id} (${container})`,
  );
}

export async function deleteSupabaseSelfHostedFunction({
  instance,
  functionName,
  signal,
}: {
  instance: InstanceWithSsh;
  functionName: string;
  signal?: AbortSignal;
}): Promise<void> {
  assertFunctionName(functionName);
  const container = instance.ssh.functionsContainer;
  assertContainerName(container);
  await withSession(instance, (session) =>
    run(
      session,
      `delete ${functionName}`,
      `docker exec ${container} sh -c 'cd ${FUNCTIONS_DIR} && rm -rf -- ${functionName}'`,
      { signal },
    ),
  );
}

/** Function log entries the edge runtime printed at or after `sinceMs`. */
export async function readSupabaseSelfHostedFunctionLogs({
  instance,
  sinceMs,
}: {
  instance: InstanceWithSsh;
  sinceMs: number;
}): Promise<SupabaseSelfHostedFunctionLog[]> {
  const container = instance.ssh.functionsContainer;
  assertContainerName(container);
  const since = (Math.max(0, sinceMs) / 1000).toFixed(3);
  const output = await withSession(instance, (session) =>
    run(
      session,
      "read function logs",
      `docker logs --timestamps --since ${since} --tail ${LOG_LINE_LIMIT} ${container} 2>&1`,
    ),
  );
  return parseEdgeRuntimeLogs(output);
}

// ─────────────────────────────────────────────────────────────────────
// Log parsing
// ─────────────────────────────────────────────────────────────────────

const TIMESTAMPED_LINE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?(.*)$/;
const LEVEL_PREFIX = /^\[(Debug|Info|Warning|Error)\] ?(.*)$/;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
// Printed by Deno.serve each time a function's worker starts.
const RUNTIME_STARTUP_LINE = /^Listening on http:\/\/localhost:9999\/$/;
const STACK_FUNCTION = /\/functions\/([A-Za-z][A-Za-z0-9_-]*)\/[^\s:)]+:\d+/;

function parseDockerTimestamp(value: string): number {
  // Docker prints nanoseconds; Date.parse wants at most milliseconds.
  return Date.parse(value.replace(/(\.\d{3})\d*Z$/, "$1Z"));
}

/**
 * Turns `docker logs --timestamps` output from the edge runtime into entries.
 *
 * The runtime prints what a function logs as `[Info] message`, `[Warning]`
 * or `[Error]`, then a blank line; a multi-line message continues until that
 * blank line. Lines without a level are the router's and the runtime's own
 * and are skipped. The runtime does not name the function, so an entry that
 * lacks the `[function-name]` prefix Dyad's prompt asks for is attributed
 * from a stack frame when it has one.
 */
export function parseEdgeRuntimeLogs(
  output: string,
): SupabaseSelfHostedFunctionLog[] {
  const entries: SupabaseSelfHostedFunctionLog[] = [];
  let current: { timestamp: number; level: string; lines: string[] } | null =
    null;
  const finish = () => {
    if (!current) return;
    let message = current.lines.join("\n").replace(ANSI_ESCAPE, "").trimEnd();
    if (!message.startsWith("[")) {
      const owner = STACK_FUNCTION.exec(message)?.[1];
      if (owner && owner !== ROUTER_FUNCTION) message = `[${owner}] ${message}`;
    }
    entries.push({
      timestamp: current.timestamp,
      level:
        current.level === "Error"
          ? "error"
          : current.level === "Warning"
            ? "warn"
            : "info",
      message,
    });
    current = null;
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = TIMESTAMPED_LINE.exec(rawLine);
    if (!line) continue;
    const [, timestamp, text] = line;
    const level = LEVEL_PREFIX.exec(text);
    if (level) {
      finish();
      if (RUNTIME_STARTUP_LINE.test(level[2])) continue;
      const parsed = parseDockerTimestamp(timestamp);
      if (!Number.isFinite(parsed)) continue;
      current = { timestamp: parsed, level: level[1], lines: [level[2]] };
    } else if (current) {
      if (text === "") finish();
      else current.lines.push(text);
    }
  }
  finish();
  return entries;
}

// ─────────────────────────────────────────────────────────────────────
// Connect-time check
// ─────────────────────────────────────────────────────────────────────

export interface SupabaseSelfHostedSshInput {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

/**
 * Connects, finds the edge runtime container that serves `url`, and returns
 * what to store. Each candidate container gets a throwaway function that
 * answers with a random token; the one whose token comes back through
 * `<url>/functions/v1/` is this instance's, which also proves deploys will
 * be served. The throwaway function is always removed again.
 */
export async function checkSupabaseSelfHostedSsh({
  url,
  anonKey,
  ssh,
}: {
  url: string;
  anonKey: string;
  ssh: SupabaseSelfHostedSshInput;
}): Promise<
  Pick<SupabaseSelfHostedSsh, "hostKeyFingerprint" | "functionsContainer">
> {
  let fingerprint = "";
  const session = await connectSsh(
    {
      host: ssh.host,
      port: ssh.port,
      username: ssh.username,
      privateKey: ssh.privateKey,
    },
    trustOnFirstUse((seen) => {
      fingerprint = seen;
    }),
  );
  try {
    const listing = await run(
      session,
      "list containers",
      `docker ps --format '{{.Names}}\t{{.Image}}'`,
    );
    const candidates = listing
      .split("\n")
      .map((line) => line.trim().split("\t"))
      .filter(
        ([name, image]) =>
          name &&
          image &&
          EDGE_RUNTIME_IMAGE.test(image) &&
          CONTAINER_NAME.test(name),
      )
      .map(([name]) => name);
    if (candidates.length === 0) {
      throw new DyadError(
        "Connected over SSH, but no Supabase edge functions container is running on this server.",
        DyadErrorKind.Precondition,
      );
    }

    for (const container of candidates) {
      if (await servesUrl({ session, container, url, anonKey })) {
        return {
          hostKeyFingerprint: fingerprint,
          functionsContainer: container,
        };
      }
    }
    throw new DyadError(
      `Found ${candidates.join(", ")} on this server, but a test function deployed there wasn't served at ${url}/functions/v1/. Check that the SSH server is the one hosting this instance.`,
      DyadErrorKind.Precondition,
    );
  } finally {
    session.end();
  }
}

async function servesUrl({
  session,
  container,
  url,
  anonKey,
}: {
  session: SshSession;
  container: string;
  url: string;
  anonKey: string;
}): Promise<boolean> {
  const token = randomBytes(16).toString("hex");
  const functionName = `dyad-check-${token.slice(0, 12)}`;
  const files = [
    {
      relativePath: `${functionName}/index.ts`,
      content: new TextEncoder().encode(
        `Deno.serve(() => new Response("${token}"));\n`,
      ),
    },
  ];
  await run(
    session,
    "deploy a test function",
    deployCommand(container, functionName),
    { input: Buffer.from(createTarArchive(files)).toString("base64") },
  );
  try {
    const response = await fetch(`${url}/functions/v1/${functionName}`, {
      headers: supabaseSelfHostedAuthHeaders(anonKey),
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    return response.ok && body.trim() === token;
  } catch (error) {
    logger.warn(`Test function on ${container} did not answer`, error);
    return false;
  } finally {
    await run(
      session,
      "remove the test function",
      `docker exec ${container} sh -c 'cd ${FUNCTIONS_DIR} && rm -rf -- ${functionName}'`,
    ).catch((error) =>
      logger.warn(`Could not remove test function from ${container}`, error),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Archive
// ─────────────────────────────────────────────────────────────────────

const BLOCK = 512;

function writeField(
  header: Uint8Array,
  offset: number,
  length: number,
  value: string,
) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > length) {
    throw new DyadError(
      `Path too long for upload: ${value}`,
      DyadErrorKind.Validation,
    );
  }
  header.set(bytes, offset);
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0");
}

/** Splits a path into ustar's 155-byte prefix and 100-byte name. */
function splitPath(path: string): [prefix: string, name: string] {
  if (new TextEncoder().encode(path).length <= 100) return ["", path];
  const slash = path.lastIndexOf("/", 155);
  if (slash <= 0) return ["", path];
  return [path.slice(0, slash), path.slice(slash + 1)];
}

/**
 * A minimal ustar archive of regular files. Parent directories are implied;
 * tar creates them on extract.
 */
export function createTarArchive(
  files: readonly SupabaseSelfHostedFunctionFile[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const file of files) {
    const header = new Uint8Array(BLOCK);
    const [prefix, name] = splitPath(file.relativePath);
    writeField(header, 0, 100, name);
    writeField(header, 100, 8, octal(0o644, 8));
    writeField(header, 108, 8, octal(0, 8));
    writeField(header, 116, 8, octal(0, 8));
    writeField(header, 124, 12, octal(file.content.length, 12));
    writeField(header, 136, 12, octal(mtime, 12));
    header.fill(0x20, 148, 156);
    header[156] = 0x30; // regular file
    writeField(header, 257, 6, "ustar");
    writeField(header, 263, 2, "00");
    writeField(header, 345, 155, prefix);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeField(header, 148, 8, `${octal(checksum, 7)}\0 `);
    parts.push(header, file.content);
    const padding = (BLOCK - (file.content.length % BLOCK)) % BLOCK;
    if (padding) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    archive.set(part, offset);
    offset += part.length;
  }
  return archive;
}

/** Test seam: closes every pooled connection. */
export function closeSupabaseSelfHostedSessions(): void {
  for (const [id, entry] of sessions) dropSession(id, entry);
}
