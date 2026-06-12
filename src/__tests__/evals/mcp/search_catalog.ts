import type { McpToolDef } from "@/pro/main/ipc/handlers/local_agent/tools/mcp_type_defs";
import { withTimeout, type EvalMcpEnvironment } from "./mcp_setup";
import type { McpServerSpec } from "./servers";

// The `mcp_search` suite spans MULTIPLE MCP servers at once: a real user
// with several servers connected searches across all of them, and the
// catalog needs to be big enough that a sloppy query pushes the target past
// `search_mcp_tools`'s top-5 truncation. This module spawns a set of specs,
// unions their `McpToolDef`s into one catalog (each def keeps its own
// `serverId`, so the production capability map routes calls to the right
// client), and tears them all down together.
//
// A spec that fails its probe or whose spawn throws is skipped (not fatal)
// so the catalog still forms from whatever connected — the same
// skip-don't-fail policy the per-server `mcp_execute` describe uses.

export interface SearchCatalog {
  /** Unioned tool defs across every server that started. */
  defs: McpToolDef[];
  /** Keys of servers that successfully started. */
  startedKeys: string[];
  /** Servers that were requested but skipped, with reasons. */
  skipped: Array<{ key: string; reason: string }>;
  close: () => Promise<void>;
}

export async function startSearchCatalog(
  specs: McpServerSpec[],
  perServerTimeoutMs = 60_000,
): Promise<SearchCatalog> {
  const envs: EvalMcpEnvironment[] = [];
  const defs: McpToolDef[] = [];
  const startedKeys: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];

  for (const spec of specs) {
    const probe = spec.probe();
    if (!probe.ok) {
      skipped.push({ key: spec.key, reason: probe.reason });
      continue;
    }
    try {
      const env = await withTimeout(
        spec.start(),
        perServerTimeoutMs,
        `${spec.key} MCP server start`,
      );
      envs.push(env);
      defs.push(...env.defs);
      startedKeys.push(spec.key);
    } catch (err) {
      skipped.push({
        key: spec.key,
        reason: `failed to start: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    defs,
    startedKeys,
    skipped,
    close: async () => {
      for (const env of envs) {
        try {
          await env.close();
        } catch {
          // best effort — keep tearing down the rest
        }
      }
    },
  };
}
