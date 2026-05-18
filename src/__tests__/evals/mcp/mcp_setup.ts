import { spawnSync } from "node:child_process";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpToolDef } from "@/pro/main/ipc/handlers/local_agent/tools/mcp_type_defs";
import { sanitizeMcpName } from "@/ipc/utils/mcp_tool_utils";

// Real chrome-devtools-mcp server, spawned via stdio and injected directly
// into `mcpManager`'s in-memory client cache. We skip the dev DB write
// path on purpose — `mcp_type_defs.collectMcpToolDefs` is mocked at the
// eval-suite level (see `tool_use.eval.ts`) to return defs sourced from
// the live `client.tools()` call below, so the rest of production
// (capability map, consent wrapper, sandbox execution) runs unmodified.

// Synthetic id used by the eval suite. Chosen to be unlikely to collide
// with anything a developer might have in their dev DB if these tests
// ever run against a dev profile by accident.
export const EVAL_MCP_SERVER_ID = 999_001;
export const EVAL_MCP_SERVER_NAME = "chrome-devtools-eval";

export interface EvalMcpEnvironment {
  serverId: number;
  serverName: string;
  client: MCPClient;
  defs: McpToolDef[];
  close: () => Promise<void>;
}

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
export function buildChromeDevtoolsMcpSpawnConfig(): {
  command: string;
  args: string[];
} {
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
 * Probe for chrome-devtools-mcp availability. Returns the spawn config
 * if reachable, otherwise null so the suite can be skipped cleanly
 * (mirrors how `hasDyadProKey` gates the rest of the eval harness).
 *
 * The probe runs `<spawn> --help`, which exercises only the package
 * download / resolution path — it does NOT launch Chrome, so a missing
 * browser binary will not fail the probe. The browser-launch failure
 * (if any) surfaces later when the first MCP tool is called.
 */
export function probeChromeDevtoolsMcp(): {
  command: string;
  args: string[];
} | null {
  const { command, args } = buildChromeDevtoolsMcpSpawnConfig();
  try {
    const probe = spawnSync(command, [...args, "--help"], {
      timeout: 30_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (probe.status === 0) return { command, args };
  } catch {
    // fallthrough
  }
  return null;
}

/**
 * Start a chrome-devtools-mcp client, probe its tool catalog, and
 * register it inside `mcpManager`. Caller MUST invoke `close()` (e.g.
 * in vitest's `afterAll`) to terminate the spawned process.
 *
 * `originForBrowser` is forwarded as a `--default-origin` style argument
 * if/when the upstream MCP server supports one — today the server takes
 * URLs per-call, so the origin is threaded into case prompts instead.
 * It's accepted here so the launcher signature already matches.
 */
export async function startEvalMcpEnvironment(_params: {
  originForBrowser: string;
}): Promise<EvalMcpEnvironment> {
  const spawnConfig = probeChromeDevtoolsMcp();
  if (!spawnConfig) {
    throw new Error(
      "chrome-devtools-mcp not reachable via `npx -y chrome-devtools-mcp@latest`. " +
        "Install npm or run with network access, or skip the mcp_execute suite.",
    );
  }

  const transport = new StdioClientTransport({
    command: spawnConfig.command,
    args: spawnConfig.args,
  });
  const client = await createMCPClient({ transport });

  const toolSet = await client.tools();
  const sanitizedServerName = sanitizeMcpName(EVAL_MCP_SERVER_NAME);
  const defs: McpToolDef[] = Object.entries(toolSet).map(
    ([toolName, mcpTool]) => {
      const sanitizedToolName = sanitizeMcpName(toolName);
      const toolKey = `${sanitizedServerName}__${sanitizedToolName}`;
      const jsName = toolKey.replace(/[^A-Za-z0-9_$]/g, "_");
      return {
        jsName: /^[0-9]/.test(jsName) ? `_${jsName}` : jsName,
        toolKey,
        serverId: EVAL_MCP_SERVER_ID,
        serverName: EVAL_MCP_SERVER_NAME,
        toolName,
        description: (mcpTool as { description?: string }).description,
        inputSchema: (mcpTool as { inputSchema?: unknown }).inputSchema,
      };
    },
  );

  // Inject the live client so `mcpManager.getClient(EVAL_MCP_SERVER_ID)`
  // (called inside `buildMcpCapabilityMap`) returns the spawned process
  // without hitting the DB.
  (mcpManager as unknown as { clients: Map<number, MCPClient> }).clients.set(
    EVAL_MCP_SERVER_ID,
    client,
  );

  return {
    serverId: EVAL_MCP_SERVER_ID,
    serverName: EVAL_MCP_SERVER_NAME,
    client,
    defs,
    close: async () => {
      try {
        await client.close();
      } finally {
        (
          mcpManager as unknown as { clients: Map<number, MCPClient> }
        ).clients.delete(EVAL_MCP_SERVER_ID);
      }
    },
  };
}
