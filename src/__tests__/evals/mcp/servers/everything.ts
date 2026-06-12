import { buildNpxStdioServerSpec } from "./npx_stdio";

// Official "everything" reference MCP server: a kitchen-sink toolset
// (echo, add, longRunningOperation, printEnv, sampleLLM, ...). No
// credentials. Used as catalog padding so the search space is large enough
// that a sloppy query pushes the target past `search_mcp_tools`'s top-5
// truncation and forces the model to refine. Pinned version.

export const everythingServerSpec = buildNpxStdioServerSpec({
  key: "everything",
  serverId: 999_012,
  serverName: "everything-eval",
  pkg: "@modelcontextprotocol/server-everything@2026.1.26",
});
