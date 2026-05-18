import { chromeDevtoolsServerSpec } from "./chrome_devtools";
import { stripeServerSpec } from "./stripe";
import { linearServerSpec } from "./linear";
import type { McpServerSpec } from "./types";

export type { McpServerSpec } from "./types";

// Registry of every MCP server the eval suite knows how to spawn.
// Add a new server by adding its spec here; `tool_use.eval.ts` picks
// up the new key automatically. Tag cases with that key via
// `McpEvalCase.server` to route them.
export const MCP_SERVER_SPECS: McpServerSpec[] = [
  chromeDevtoolsServerSpec,
  stripeServerSpec,
  linearServerSpec,
];

export function getMcpServerSpec(key: string): McpServerSpec | undefined {
  return MCP_SERVER_SPECS.find((s) => s.key === key);
}
