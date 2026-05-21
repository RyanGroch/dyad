import log from "electron-log";
import { db } from "../../db";
import { mcpServers, mcpToolConsents } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { createTypedHandler } from "./base";

import { resolveConsent } from "../utils/mcp_consent";
import { getStoredConsent } from "../utils/mcp_consent";
import { mcpManager } from "../utils/mcp_manager";
import { disconnectOAuth, runOAuthFlow } from "../utils/mcp_oauth_flow";
import {
  encryptToString,
  oauthStateHasTokens,
} from "../utils/mcp_oauth_provider";
import {
  mcpContracts,
  type McpServer,
  type McpTransport,
  type McpConsentValue,
} from "../types/mcp";

const logger = log.scope("mcp_handlers");

// Helper to cast DB server to typed server. Strips `oauthState`
// (encrypted token blob) before returning -- the renderer never needs
// the encrypted material and exposing it would be a footgun.
function toMcpServer(dbServer: typeof mcpServers.$inferSelect): McpServer {
  return {
    id: dbServer.id,
    name: dbServer.name,
    transport: dbServer.transport as McpTransport,
    command: dbServer.command,
    args: dbServer.args,
    envJson: dbServer.envJson,
    headersJson: dbServer.headersJson,
    url: dbServer.url,
    enabled: dbServer.enabled,
    oauthEnabled: dbServer.oauthEnabled,
    // Reflects whether usable access tokens are stored. `oauthState`
    // alone is not enough: an ambient transport build can persist
    // `clientInformation` (via DCR) without tokens, which would
    // otherwise flip this to true.
    oauthConnected: oauthStateHasTokens(dbServer.oauthState),
    oauthClientId: dbServer.oauthClientId,
    // Never expose the encrypted blob (or, worse, plaintext) to the
    // renderer. Send only the boolean so the UI can render
    // "(set — leave blank to keep)" placeholder text without the
    // process ever holding the secret.
    hasOauthClientSecret: dbServer.oauthClientSecret !== null,
    oauthScope: dbServer.oauthScope,
    createdAt: dbServer.createdAt,
    updatedAt: dbServer.updatedAt,
  };
}

export function registerMcpHandlers() {
  // CRUD for MCP servers
  createTypedHandler(mcpContracts.listServers, async () => {
    const servers = await db.select().from(mcpServers);
    return servers.map(toMcpServer);
  });

  createTypedHandler(mcpContracts.createServer, async (_, params) => {
    const {
      name,
      transport,
      command,
      args,
      envJson,
      headersJson,
      url,
      enabled,
      oauthEnabled,
      oauthClientId,
      oauthClientSecret,
      oauthScope,
    } = params;
    // Handle args: can be string (JSON), array, or null/undefined
    const parsedArgs = args
      ? typeof args === "string"
        ? (JSON.parse(args) as string[])
        : args
      : null;
    // Handle envJson: can be string (JSON), object, or null/undefined
    const parsedEnvJson = envJson
      ? typeof envJson === "string"
        ? (JSON.parse(envJson) as Record<string, string>)
        : envJson
      : null;
    // Handle headersJson: can be string (JSON), object, or null/undefined
    const parsedHeadersJson = headersJson
      ? typeof headersJson === "string"
        ? (JSON.parse(headersJson) as Record<string, string>)
        : headersJson
      : null;
    const result = await db
      .insert(mcpServers)
      .values({
        name,
        transport,
        command: command || null,
        args: parsedArgs,
        envJson: parsedEnvJson,
        headersJson: parsedHeadersJson,
        url: url || null,
        enabled: !!enabled,
        oauthEnabled: !!oauthEnabled,
        oauthClientId: oauthClientId ?? null,
        // Encrypt the plaintext client_secret at the IPC boundary so
        // it never lives in the row payload that gets logged /
        // serialized later in this process.
        oauthClientSecret: oauthClientSecret
          ? encryptToString(oauthClientSecret)
          : null,
        oauthScope: oauthScope ?? null,
      })
      .returning();
    return toMcpServer(result[0]);
  });

  createTypedHandler(mcpContracts.updateServer, async (_, params) => {
    const update: any = {};
    if (params.name !== undefined) update.name = params.name;
    if (params.transport !== undefined) update.transport = params.transport;
    if (params.command !== undefined) update.command = params.command;
    if (params.args !== undefined)
      update.args = params.args
        ? typeof params.args === "string"
          ? JSON.parse(params.args)
          : params.args
        : null;
    if (params.cwd !== undefined) update.cwd = params.cwd;
    if (params.envJson !== undefined)
      update.envJson = params.envJson
        ? typeof params.envJson === "string"
          ? JSON.parse(params.envJson)
          : params.envJson
        : null;
    if (params.headersJson !== undefined)
      update.headersJson = params.headersJson
        ? typeof params.headersJson === "string"
          ? JSON.parse(params.headersJson)
          : params.headersJson
        : null;
    if (params.url !== undefined) update.url = params.url;
    if (params.enabled !== undefined) update.enabled = !!params.enabled;
    if (params.oauthEnabled !== undefined)
      update.oauthEnabled = !!params.oauthEnabled;
    if (params.oauthClientId !== undefined) {
      update.oauthClientId = params.oauthClientId;
      // Changing the client_id invalidates any stored `clientInformation`
      // (it was seeded from the old value). Clearing `oauth_state` here
      // forces the provider to re-seed from the new column on next
      // use; without this, the old client_id keeps winning even after
      // the user edits the field.
      update.oauthState = null;
    }
    // Tri-state semantics on the IPC schema (see McpServerUpdateSchema):
    //   undefined -> field omitted, keep stored secret untouched
    //   null      -> explicit clear (user clicked "Clear secret")
    //   string    -> replace with new plaintext (encrypted here)
    // The cached client info is wiped because the secret is part of
    // the seeded `clientInformation`; without this, the SDK keeps
    // using the old secret silently on subsequent token exchanges.
    if (params.oauthClientSecret !== undefined) {
      update.oauthClientSecret = params.oauthClientSecret
        ? encryptToString(params.oauthClientSecret)
        : null;
      update.oauthState = null;
    }
    if (params.oauthScope !== undefined) update.oauthScope = params.oauthScope;

    const result = await db
      .update(mcpServers)
      .set(update)
      .where(eq(mcpServers.id, params.id))
      .returning();
    // If server config changed, dispose cached client to be recreated on next use
    try {
      mcpManager.dispose(params.id);
    } catch {}
    return toMcpServer(result[0]);
  });

  createTypedHandler(mcpContracts.deleteServer, async (_, id) => {
    try {
      mcpManager.dispose(id);
    } catch {}
    await db.delete(mcpServers).where(eq(mcpServers.id, id));
    return { success: true };
  });

  // Tools listing (dynamic)
  createTypedHandler(mcpContracts.listTools, async (_, serverId) => {
    // Hard cap on how long we'll wait for a single server's tools
    // listing. The MCP SSE transport can block indefinitely during
    // its initialize handshake against an unconnected / unreachable
    // OAuth-gated server; without this ceiling, the renderer's
    // batched tool-listing query hangs and the UI shows empty tools
    // for ALL servers until the slowest one settles.
    const LIST_TOOLS_TIMEOUT_MS = 8_000;
    try {
      const result = await Promise.race([
        (async () => {
          const client = await mcpManager.getClient(serverId);
          const remoteTools = await client.tools();
          return Promise.all(
            Object.entries(remoteTools).map(async ([name, mcpTool]) => ({
              name,
              description: mcpTool.description ?? null,
              consent: (await getStoredConsent(serverId, name)) as
                | McpConsentValue
                | undefined,
            })),
          );
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out after ${LIST_TOOLS_TIMEOUT_MS / 1000}s waiting for tools from server ${serverId}.`,
                ),
              ),
            LIST_TOOLS_TIMEOUT_MS,
          ),
        ),
      ]);
      return result;
    } catch (e) {
      // Common cause for OAuth-gated servers: the transport built
      // before tokens were saved is still cached; surface the error
      // shape so the user sees more than a silent empty list.
      logger.error(
        `Failed to list tools for server ${serverId}: ${
          e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        }`,
      );
      return [];
    }
  });

  // Consents
  createTypedHandler(mcpContracts.getToolConsents, async () => {
    const consents = await db.select().from(mcpToolConsents);
    return consents.map((c) => ({
      ...c,
      consent: c.consent as McpConsentValue,
    }));
  });

  createTypedHandler(mcpContracts.setToolConsent, async (_, params) => {
    const existing = await db
      .select()
      .from(mcpToolConsents)
      .where(
        and(
          eq(mcpToolConsents.serverId, params.serverId),
          eq(mcpToolConsents.toolName, params.toolName),
        ),
      );
    if (existing.length > 0) {
      const result = await db
        .update(mcpToolConsents)
        .set({ consent: params.consent })
        .where(
          and(
            eq(mcpToolConsents.serverId, params.serverId),
            eq(mcpToolConsents.toolName, params.toolName),
          ),
        )
        .returning();
      return {
        ...result[0],
        consent: result[0].consent as McpConsentValue,
      };
    } else {
      const result = await db
        .insert(mcpToolConsents)
        .values({
          serverId: params.serverId,
          toolName: params.toolName,
          consent: params.consent,
        })
        .returning();
      return {
        ...result[0],
        consent: result[0].consent as McpConsentValue,
      };
    }
  });

  // Tool consent request/response handshake
  // Receive consent response from renderer
  createTypedHandler(mcpContracts.respondToConsent, async (_, data) => {
    resolveConsent(data.requestId, data.decision);
  });

  // OAuth: kick off the full flow against the named MCP server. The
  // main-process loopback listener captures the redirect, the
  // `@ai-sdk/mcp` `auth()` function drives PKCE + token exchange, and
  // tokens land in the encrypted `oauth_state` column.
  createTypedHandler(mcpContracts.startOAuth, async (_, params) => {
    return await runOAuthFlow({
      serverId: params.serverId,
      callbackPort: params.callbackPort,
      scope: params.scope,
    });
  });

  // OAuth disconnect: clear stored tokens + client info. Forces the
  // next tool call to require a fresh consent flow.
  createTypedHandler(mcpContracts.disconnectOAuth, async (_, serverId) => {
    return await disconnectOAuth(serverId);
  });

  logger.debug("Registered MCP IPC handlers");
}
