import { createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import type { MCPClient } from "@ai-sdk/mcp";
import { buildEvalMcpEnvironment, type EvalMcpEnvironment } from "../mcp_setup";
import type { McpServerSpec } from "./types";

// Stripe MCP server spec. `@stripe/mcp` is a thin stdio→HTTP proxy that
// forwards MCP messages to `https://mcp.stripe.com`, so the tool catalog
// is whatever the hosted Stripe MCP exposes (no `--tools` flag — tool
// permissions are controlled by the Restricted API Key's scopes).
//
// Cases for this server don't need a fixture HTTP server — they hit the
// live Stripe API directly. The probe rejects anything other than
// test-mode keys (`sk_test_...` or `rk_test_...`) so an eval run cannot
// accidentally drive a live Stripe account.

const SERVER_ID = 999_002;
const SERVER_NAME = "stripe-eval";

const TEST_KEY_PREFIXES = ["sk_test_", "rk_test_"] as const;

function isTestModeKey(key: string): boolean {
  return TEST_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Build the stripe-mcp spawn config from env vars.
 *
 * Env knobs:
 *   EVAL_STRIPE_MCP_COMMAND    override binary (default `npx`)
 *   EVAL_STRIPE_MCP_PACKAGE    override package spec (default
 *                              `@stripe/mcp`)
 *   EVAL_STRIPE_MCP_EXTRA_ARGS extra args appended verbatim
 *                              (space-separated)
 *
 * The Stripe key is read from `STRIPE_API_KEY` and forwarded as
 * `--api-key=<key>`. Use a Restricted API Key (`rk_test_...`) scoped to
 * the operations you want the eval to perform — Stripe deprecated the
 * server-side `--tools` allowlist in favor of key-scope enforcement.
 */
function buildSpawnConfig(apiKey: string): { command: string; args: string[] } {
  const command = process.env.EVAL_STRIPE_MCP_COMMAND || "npx";
  const pkg = process.env.EVAL_STRIPE_MCP_PACKAGE || "@stripe/mcp";
  const args: string[] = command === "npx" ? ["-y", pkg] : [];
  args.push(`--api-key=${apiKey}`);
  if (process.env.EVAL_STRIPE_MCP_EXTRA_ARGS) {
    args.push(
      ...process.env.EVAL_STRIPE_MCP_EXTRA_ARGS.split(/\s+/).filter(Boolean),
    );
  }
  return { command, args };
}

function probe(): { ok: true } | { ok: false; reason: string } {
  // `@stripe/mcp` has no `--help` and no offline mode — its CLI just
  // parses args and immediately opens a streaming HTTP connection to
  // `mcp.stripe.com`. There is no cheap reachability check we can run
  // that doesn't either (a) require network round-trips and (b) burn
  // an authenticated request budget. So the probe just validates the
  // env-var shape and defers reachability to `start()`, where a real
  // `createMCPClient` failure surfaces with a meaningful error.
  const key = process.env.STRIPE_API_KEY;
  if (!key) {
    return {
      ok: false,
      reason:
        "STRIPE_API_KEY not set — required to spawn @stripe/mcp. Use a test-mode key (sk_test_... or rk_test_...).",
    };
  }
  if (!isTestModeKey(key)) {
    return {
      ok: false,
      reason:
        "STRIPE_API_KEY is not a test-mode key (expected `sk_test_...` or `rk_test_...`). " +
        "The eval suite refuses to drive live Stripe accounts. " +
        "Create a Restricted API Key in test mode at https://dashboard.stripe.com/test/apikeys.",
    };
  }
  return { ok: true };
}

async function start(): Promise<EvalMcpEnvironment> {
  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey || !isTestModeKey(apiKey)) {
    throw new Error(
      "STRIPE_API_KEY missing or not a test-mode key (sk_test_... / rk_test_...). " +
        "Refusing to spawn @stripe/mcp.",
    );
  }

  const spawnConfig = buildSpawnConfig(apiKey);
  const transport = new StdioClientTransport({
    command: spawnConfig.command,
    args: spawnConfig.args,
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

export const stripeServerSpec: McpServerSpec = {
  key: "stripe",
  serverId: SERVER_ID,
  serverName: SERVER_NAME,
  needsFixtureServer: false,
  probe,
  start,
};
