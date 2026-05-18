import type { EvalMcpEnvironment } from "../mcp_setup";

// One MCP server the eval suite knows how to spawn and drive. Each spec
// owns its own probe (so an unconfigured server skips cleanly instead of
// failing) and its own spawn config. The runner groups MCP_CASES by
// `case.server`, then for each group looks up the matching spec and
// starts a single MCP environment for the whole group.
export interface McpServerSpec {
  /**
   * Stable key used to tag cases (`McpEvalCase.server`) and to filter
   * via the `EVAL_MCP_SERVERS` env var. Lowercase snake_case.
   */
  key: string;
  /**
   * Synthetic numeric id injected into `mcpManager`'s in-memory client
   * cache. Must be unique across specs to avoid cache collisions when
   * the suite is extended.
   */
  serverId: number;
  /**
   * Display name passed through `sanitizeMcpName` to derive each
   * tool's `jsName`. Shows up in the dynamic
   * `execute_sandbox_script` description the model sees.
   */
  serverName: string;
  /**
   * True if cases for this server want the local HTTP fixture server
   * running. The fixture origin is substituted into prompts via the
   * `{ORIGIN}` placeholder. Stripe etc. don't need it.
   */
  needsFixtureServer: boolean;
  /**
   * Cheap reachability check that runs before any case from this
   * server. Returns `{ ok: false, reason }` to skip the whole group
   * with a recorded reason (missing API key, server binary not on
   * PATH, etc.). Should NOT spawn the real server — that happens in
   * `start()`.
   */
  probe: () => { ok: true } | { ok: false; reason: string };
  /**
   * Spawn the MCP server, register its client with `mcpManager`, and
   * return an `EvalMcpEnvironment` the caller can use to set tool
   * defs and tear down.
   */
  start: () => Promise<EvalMcpEnvironment>;
}
