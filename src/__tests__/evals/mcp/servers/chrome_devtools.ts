import { spawnSync } from "node:child_process";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import type { MCPClient } from "@ai-sdk/mcp";
import { buildEvalMcpEnvironment, type EvalMcpEnvironment } from "../mcp_setup";
import type { McpServerSpec } from "./types";

// chrome-devtools MCP server spec. Spawns the real upstream server via
// `npx -y chrome-devtools-mcp@latest` (overrideable), pointed at an
// auto-cleaned ephemeral browser profile. Cases for this server use the
// local fixture HTTP server (see `mcp/fixture_server.ts`) as their nav
// target — `{ORIGIN}` placeholders in case prompts are substituted by
// the runner.

const SERVER_ID = 999_001;
const SERVER_NAME = "chrome-devtools-eval";

/**
 * Build the chrome-devtools-mcp spawn config from env vars.
 *
 * Env knobs:
 *   EVAL_MCP_COMMAND         override binary (default `npx`)
 *   EVAL_MCP_PACKAGE         override package spec (default
 *                            `chrome-devtools-mcp@latest`)
 *   EVAL_MCP_EXECUTABLE_PATH path to Chrome/Chromium-compatible binary
 *                            (forwarded as `--executablePath=...`).
 *                            Required when no Chrome is installed on
 *                            PATH — e.g. point at a Helium AppImage.
 *   EVAL_MCP_HEADLESS        "false" to disable headless (default headless)
 *   EVAL_MCP_EXTRA_ARGS      extra args appended verbatim (space-separated;
 *                            does not handle quoted whitespace)
 *
 * Safe defaults applied:
 *   --isolated                ephemeral user-data-dir, auto-cleaned
 *   --headless                no GUI window unless EVAL_MCP_HEADLESS=false
 *   --no-usage-statistics     no analytics from eval runs
 */
function buildSpawnConfig(): { command: string; args: string[] } {
  const command = process.env.EVAL_MCP_COMMAND || "npx";
  const pkg = process.env.EVAL_MCP_PACKAGE || "chrome-devtools-mcp@latest";
  const args: string[] = command === "npx" ? ["-y", pkg] : [];

  args.push("--isolated");
  args.push("--no-usage-statistics");
  if (process.env.EVAL_MCP_HEADLESS !== "false") {
    args.push("--headless");
  }
  if (process.env.EVAL_MCP_EXECUTABLE_PATH) {
    args.push(`--executablePath=${process.env.EVAL_MCP_EXECUTABLE_PATH}`);
  }
  if (process.env.EVAL_MCP_EXTRA_ARGS) {
    args.push(...process.env.EVAL_MCP_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  }
  return { command, args };
}

/**
 * Probe runs `<spawn> --help`, which exercises only the package
 * download / resolution path — it does NOT launch Chrome, so a missing
 * browser binary will not fail the probe. The browser-launch failure
 * (if any) surfaces later when the first MCP tool is called.
 */
function probe(): { ok: true } | { ok: false; reason: string } {
  const { command, args } = buildSpawnConfig();
  try {
    const result = spawnSync(command, [...args, "--help"], {
      timeout: 30_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (result.status === 0) return { ok: true };
    return {
      ok: false,
      reason: `chrome-devtools-mcp probe (\`${command} ${args.join(" ")} --help\`) exited with status ${result.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `chrome-devtools-mcp probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function start(): Promise<EvalMcpEnvironment> {
  const spawnConfig = buildSpawnConfig();
  const transport = new StdioClientTransport({
    command: spawnConfig.command,
    args: spawnConfig.args,
  });
  const client: MCPClient = await createMCPClient({ transport });

  // Inject the live client so `mcpManager.getClient(SERVER_ID)`
  // (called inside `buildMcpCapabilityMap`) returns the spawned process
  // without hitting the DB.
  (mcpManager as unknown as { clients: Map<number, MCPClient> }).clients.set(
    SERVER_ID,
    client,
  );

  return buildEvalMcpEnvironment({
    serverId: SERVER_ID,
    serverName: SERVER_NAME,
    client,
  });
}

export const chromeDevtoolsServerSpec: McpServerSpec = {
  key: "chrome_devtools",
  serverId: SERVER_ID,
  serverName: SERVER_NAME,
  needsFixtureServer: true,
  probe,
  start,
};
