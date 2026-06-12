import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import { buildEvalMcpEnvironment, type EvalMcpEnvironment } from "../mcp_setup";
import type { McpServerSpec } from "./types";

// GitHub's hosted remote MCP server (Streamable HTTP). No local install: we
// connect over HTTP with a Personal Access Token as a bearer credential,
// mirroring how production creates `http` MCP clients. A read-only
// fine-grained PAT is enough for the discovery/search cases.
//
// The PAT is read from the environment at runtime and never stored. Set one
// of GITHUB_PAT / GITHUB_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN to run the
// GitHub cases; without it the server (and its cases) cleanly skip.
//
// Note: this is a hosted remote endpoint, so its toolset is not version-
// pinnable the way the npx servers are — GitHub controls it. Keep case
// assertions loose (acceptable tool in the catalog / top-K) and re-confirm
// the toolset if GitHub changes it.

const SERVER_ID = 999_013;
const SERVER_NAME = "github-eval";
const GITHUB_MCP_URL =
  process.env.EVAL_GITHUB_MCP_URL || "https://api.githubcopilot.com/mcp/";

function readPat(): string | undefined {
  return (
    process.env.GITHUB_PAT ||
    process.env.GITHUB_TOKEN ||
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    undefined
  );
}

function probe(): { ok: true } | { ok: false; reason: string } {
  if (!readPat()) {
    return {
      ok: false,
      reason:
        "no GitHub PAT in env (set GITHUB_PAT / GITHUB_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN)",
    };
  }
  return { ok: true };
}

async function start(): Promise<EvalMcpEnvironment> {
  const pat = readPat();
  if (!pat) throw new Error("GitHub PAT missing at start()");

  const client: MCPClient = await createMCPClient({
    transport: {
      type: "http",
      url: GITHUB_MCP_URL,
      headers: { Authorization: `Bearer ${pat}` },
    },
  });

  // Inject the live client so `mcpManager.getClient(SERVER_ID)` (called
  // inside the production capability map) returns it without hitting the DB.
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

export const githubServerSpec: McpServerSpec = {
  key: "github",
  serverId: SERVER_ID,
  serverName: SERVER_NAME,
  needsFixtureServer: false,
  probe,
  start,
};
