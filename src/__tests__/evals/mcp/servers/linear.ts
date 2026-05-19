import { createMCPClient } from "@ai-sdk/mcp";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import type { MCPClient } from "@ai-sdk/mcp";
import { buildEvalMcpEnvironment, type EvalMcpEnvironment } from "../mcp_setup";
import { getOAuthToken, loadCachedToken } from "../oauth_helper";
import type { McpServerSpec } from "./types";

// Linear MCP server spec. Linear runs a remote MCP server at
// `https://mcp.linear.app/sse` (streaming-HTTP transport, not stdio)
// gated by Linear's OAuth flow. Tools cover the Linear API surface —
// list issues, get issue, list teams, list projects, search, comments.
//
// Auth: user registers an OAuth application in their Linear workspace
// (https://linear.app/settings/api/applications) with the redirect
// URI `http://localhost:<EVAL_LINEAR_OAUTH_PORT>/callback` (default
// 53682). The eval suite walks the OAuth flow on first run, prints the
// authorize URL, tries to open the user's browser, awaits the callback
// on the configured loopback port, exchanges the code for an access
// token, and caches it under ~/.cache/dyad-eval/oauth/linear.json.
// Subsequent runs reuse the cached token until it expires.

const SERVER_ID = 999_003;
const SERVER_NAME = "linear-eval";
const CACHE_KEY = "linear";
const DEFAULT_CALLBACK_PORT = 53_682;
const LINEAR_MCP_URL = "https://mcp.linear.app/sse";
const LINEAR_AUTHORIZE_ENDPOINT = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const DEFAULT_SCOPE = "read";

function getCallbackPort(): number {
  const raw = process.env.EVAL_LINEAR_OAUTH_PORT;
  if (!raw) return DEFAULT_CALLBACK_PORT;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1024 || n > 65_535) {
    throw new Error(
      `EVAL_LINEAR_OAUTH_PORT=${raw} is not a valid TCP port (1024-65535).`,
    );
  }
  return n;
}

function probe(): { ok: true } | { ok: false; reason: string } {
  if (!process.env.LINEAR_CLIENT_ID) {
    return {
      ok: false,
      reason:
        "LINEAR_CLIENT_ID not set — required for Linear OAuth. Register an OAuth app at https://linear.app/settings/api/applications and export its Client ID.",
    };
  }
  try {
    getCallbackPort();
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  // If we already have a cached token, no TTY is needed at start time.
  // Otherwise we need an interactive terminal to walk the OAuth flow.
  const cached = loadCachedToken(CACHE_KEY);
  if (!cached && !process.stdin.isTTY && process.env.EVAL_OAUTH_AUTO !== "1") {
    return {
      ok: false,
      reason:
        "No cached Linear OAuth token and current process is not a TTY. Run the eval interactively once to acquire a token.",
    };
  }
  return { ok: true };
}

async function start(): Promise<EvalMcpEnvironment> {
  const clientId = process.env.LINEAR_CLIENT_ID;
  if (!clientId) {
    throw new Error("LINEAR_CLIENT_ID not set");
  }

  const token = await getOAuthToken({
    cacheKey: CACHE_KEY,
    displayName: "Linear",
    authorizationEndpoint: LINEAR_AUTHORIZE_ENDPOINT,
    tokenEndpoint: LINEAR_TOKEN_ENDPOINT,
    clientId,
    clientSecret: process.env.LINEAR_CLIENT_SECRET,
    scope: process.env.EVAL_LINEAR_SCOPE || DEFAULT_SCOPE,
    callbackPort: getCallbackPort(),
  });

  // Linear's MCP endpoint at `/sse` is the SSE transport (older of the
  // two HTTP-based MCP transports). Client GETs `/sse` to establish a
  // server-sent-event stream, then POSTs to a session endpoint the
  // server returns via the stream. Using `StreamableHTTPClientTransport`
  // here would 404 because that transport expects a single POST endpoint.
  const transport = new SSEClientTransport(new URL(LINEAR_MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
  const client: MCPClient = await createMCPClient({ transport });

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

export const linearServerSpec: McpServerSpec = {
  key: "linear",
  serverId: SERVER_ID,
  serverName: SERVER_NAME,
  needsFixtureServer: false,
  probe,
  start,
};
