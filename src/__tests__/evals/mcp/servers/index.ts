import { chromeDevtoolsServerSpec } from "./chrome_devtools";
import { stripeServerSpec } from "./stripe";
import { linearServerSpec } from "./linear";
import { filesystemServerSpec } from "./filesystem";
import { memoryServerSpec } from "./memory";
import { everythingServerSpec } from "./everything";
import { githubServerSpec } from "./github";
import type { McpServerSpec } from "./types";

export type { McpServerSpec } from "./types";

// Registry of every MCP server the eval suite knows how to spawn.
// Add a new server by adding its spec here; `tool_use.eval.ts` picks
// up the new key automatically. Tag cases with that key via
// `McpEvalCase.server` to route them.
//
// The no-cred npx servers (filesystem/memory/everything) are primarily the
// catalog the `mcp_search` suite spans; they can also host `mcp_execute`
// cases.
export const MCP_SERVER_SPECS: McpServerSpec[] = [
  chromeDevtoolsServerSpec,
  stripeServerSpec,
  linearServerSpec,
  filesystemServerSpec,
  memoryServerSpec,
  everythingServerSpec,
  githubServerSpec,
];

export function getMcpServerSpec(key: string): McpServerSpec | undefined {
  return MCP_SERVER_SPECS.find((s) => s.key === key);
}
