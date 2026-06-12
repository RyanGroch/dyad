import { spawnSync } from "node:child_process";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import { buildEvalMcpEnvironment, type EvalMcpEnvironment } from "../mcp_setup";
import type { McpServerSpec } from "./types";

// Factory for the no-credential MCP servers that ship as npm packages and
// speak stdio (filesystem, memory, everything, ...). They all spawn the
// same way: `npx -y <pinned-package> [args]`. The only per-server bits are
// the pinned package spec, any positional args (e.g. an allowed directory),
// and optional env. Versions are PINNED on purpose so a server adding or
// renaming a tool can't silently shift the BM25 catalog the search suite
// asserts against.

export interface NpxStdioServerOptions {
  key: string;
  serverId: number;
  serverName: string;
  /** Pinned package spec, e.g. `@modelcontextprotocol/server-memory@2026.1.26`. */
  pkg: string;
  /**
   * Build the positional args appended after the package spec, plus an
   * optional cleanup hook run on teardown (e.g. remove a temp dir created
   * for a server that needs a sandbox root). Called once per `start()`.
   */
  buildArgs?: () => { args: string[]; cleanup?: () => void | Promise<void> };
  /** Extra env merged over `process.env` for the spawned server. */
  env?: () => Record<string, string>;
}

export function buildNpxStdioServerSpec(
  opts: NpxStdioServerOptions,
): McpServerSpec {
  const command = "npx";

  // Cheap reachability check: confirm the `npx` runner exists. Package
  // download/resolution is deferred to `start()` (a failure there surfaces
  // as a clean skip via the runner's try/catch), mirroring the
  // chrome-devtools spec — many of these servers have no `--help`, so we
  // can't probe the package itself without paying its full download.
  function probe(): { ok: true } | { ok: false; reason: string } {
    try {
      const result = spawnSync(command, ["--version"], {
        timeout: 15_000,
        stdio: ["ignore", "ignore", "ignore"],
      });
      if (result.status === 0) return { ok: true };
      return {
        ok: false,
        reason: `\`${command} --version\` exited with status ${result.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        reason: `${opts.key} probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async function start(): Promise<EvalMcpEnvironment> {
    const built = opts.buildArgs?.() ?? { args: [] };
    const transport = new StdioClientTransport({
      command,
      args: ["-y", opts.pkg, ...built.args],
      env: { ...process.env, ...opts.env?.() } as Record<string, string>,
    });
    const client: MCPClient = await createMCPClient({ transport });

    // Inject the live client so `mcpManager.getClient(serverId)` (called
    // inside the production `buildMcpCapabilityMap`) returns the spawned
    // process without hitting the DB.
    (mcpManager as unknown as { clients: Map<number, MCPClient> }).clients.set(
      opts.serverId,
      client,
    );

    const env = await buildEvalMcpEnvironment({
      serverId: opts.serverId,
      serverName: opts.serverName,
      client,
    });

    // Wrap close to also run the per-spawn cleanup (e.g. temp-dir removal).
    const baseClose = env.close;
    return {
      ...env,
      close: async () => {
        try {
          await baseClose();
        } finally {
          await built.cleanup?.();
        }
      },
    };
  }

  return {
    key: opts.key,
    serverId: opts.serverId,
    serverName: opts.serverName,
    needsFixtureServer: false,
    probe,
    start,
  };
}
