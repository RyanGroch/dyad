import { buildNpxStdioServerSpec } from "./npx_stdio";

// Official knowledge-graph memory MCP server. No credentials. Pinned
// version. Graph state is irrelevant to the search suite (we test tool
// discovery, not stored data), so it spawns with defaults.
//
// Useful near-miss clusters for the search suite: create_entities /
// create_relations / add_observations, delete_entities / delete_relations /
// delete_observations, and search_nodes / open_nodes / read_graph.

export const memoryServerSpec = buildNpxStdioServerSpec({
  key: "memory",
  serverId: 999_011,
  serverName: "memory-eval",
  pkg: "@modelcontextprotocol/server-memory@2026.1.26",
});
