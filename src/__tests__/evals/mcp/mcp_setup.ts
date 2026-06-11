import { mcpManager } from "@/ipc/utils/mcp_manager";
import type { MCPClient } from "@ai-sdk/mcp";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { asSchema } from "@ai-sdk/provider-utils";
import type { McpToolDef } from "@/pro/main/ipc/handlers/local_agent/tools/mcp_type_defs";
import { sanitizeMcpName } from "@/ipc/utils/mcp_tool_utils";

// Shared MCP environment plumbing used by every server spec under
// `servers/`. Each spec spawns its own stdio client and calls
// `buildEvalMcpEnvironment` to package the defs + close hook in a
// uniform shape the runner consumes.
//
// `mcp_type_defs.collectMcpToolDefs` is mocked at the eval-suite level
// (see `tool_use.eval.ts`) to return defs sourced from
// `EvalMcpEnvironment.defs` below, so the rest of production
// (capability map, consent wrapper, sandbox execution) runs unmodified.

export interface EvalMcpEnvironment {
  serverId: number;
  serverName: string;
  client: MCPClient;
  defs: McpToolDef[];
  close: () => Promise<void>;
}

/**
 * Race a promise against a timeout. Used to bound the cost of spinning
 * up an MCP server: both `createMCPClient` (initialize handshake) and
 * `client.tools()` can hang indefinitely when the upstream server
 * silently closes the transport (Stripe does this on auth rejection),
 * so each call site wraps its async work with this helper instead of
 * letting vitest hit its 120s hookTimeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Probe a live MCP client's tool catalog, derive `McpToolDef`s in the
 * same shape `collectMcpToolDefs` would produce in production, and
 * return a ready-to-use `EvalMcpEnvironment`. The caller is responsible
 * for spawning the client and registering it with `mcpManager` before
 * calling this; the `close` hook tears down both the client and the
 * `mcpManager` cache entry.
 */
export async function buildEvalMcpEnvironment(params: {
  serverId: number;
  serverName: string;
  client: MCPClient;
}): Promise<EvalMcpEnvironment> {
  const { serverId, serverName, client } = params;
  const toolSet = await client.tools();
  const sanitizedServerName = sanitizeMcpName(serverName);
  const defs: McpToolDef[] = await Promise.all(
    Object.entries(toolSet).map(async ([toolName, mcpTool]) => {
      const sanitizedToolName = sanitizeMcpName(toolName);
      const toolKey = `${sanitizedServerName}__${sanitizedToolName}`;
      const jsName = toolKey.replace(/[^A-Za-z0-9_$]/g, "_");
      // Normalize to JSON Schema exactly as production `collectMcpToolDefs`
      // does, so the type declarations the model sees match prod.
      let inputSchema: JSONSchema7;
      try {
        inputSchema = await asSchema(mcpTool.inputSchema).jsonSchema;
      } catch {
        inputSchema = {
          type: "object",
          properties: {},
          additionalProperties: false,
        };
      }
      return {
        jsName: /^[0-9]/.test(jsName) ? `_${jsName}` : jsName,
        toolKey,
        serverId,
        serverName,
        toolName,
        description: (mcpTool as { description?: string }).description,
        inputSchema,
      };
    }),
  );

  return {
    serverId,
    serverName,
    client,
    defs,
    close: async () => {
      try {
        await client.close();
      } finally {
        (
          mcpManager as unknown as { clients: Map<number, MCPClient> }
        ).clients.delete(serverId);
      }
    },
  };
}
