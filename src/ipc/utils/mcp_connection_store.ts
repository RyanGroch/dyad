import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { mcpAppConfigs, mcpServers } from "../../db/schema";
import {
  appConfigConnectionId,
  parseMcpConnectionId,
} from "@/shared/mcp_connection_id";

/**
 * Storage for anything Dyad connects to, addressed by connection id (see
 * `src/shared/mcp_connection_id.ts`). The connection cache, the OAuth flow
 * and the OAuth client sync read and write configurations only through
 * here, so they work the same for a plugin's default configuration
 * (`mcp_servers`) and an app-specific one (`mcp_app_configs`).
 */
export interface McpConnectionRecord {
  connectionId: number;
  /** The plugin: the `mcp_servers` row, for either kind. */
  serverId: number;
  appConfigId: number | null;
  /** The plugin's name. Tool keys use it, so they don't depend on configs. */
  pluginName: string;
  /** What the user sees: the plugin name, plus the configuration's name. */
  displayName: string;
  transport: string;
  command: string | null;
  args: string[] | null;
  // Legacy plaintext columns; app-specific configurations never have them.
  envJson: Record<string, string> | null;
  headersJson: Record<string, string> | null;
  envEncrypted: string | null;
  headersEncrypted: string | null;
  url: string | null;
  oauthEnabled: boolean;
  oauthState: string | null;
  oauthClientId: string | null;
  oauthClientSecret: string | null;
  oauthScope: string | null;
  oauthCallbackPort: number | null;
  /** The plugin's catalog entry; app-specific configurations share it. */
  catalogSlug: string | null;
}

export function appConfigDisplayName(
  pluginName: string,
  configName: string,
): string {
  return `${pluginName} (${configName})`;
}

export async function readMcpConnection(
  connectionId: number,
): Promise<McpConnectionRecord | undefined> {
  const ref = parseMcpConnectionId(connectionId);
  if (ref.kind === "plugin") {
    const [row] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, ref.serverId));
    if (!row) return undefined;
    return {
      connectionId,
      serverId: row.id,
      appConfigId: null,
      pluginName: row.name,
      displayName: row.name,
      transport: row.transport,
      command: row.command,
      args: row.args,
      envJson: row.envJson,
      headersJson: row.headersJson,
      envEncrypted: row.envEncrypted,
      headersEncrypted: row.headersEncrypted,
      url: row.url,
      oauthEnabled: row.oauthEnabled,
      oauthState: row.oauthState,
      oauthClientId: row.oauthClientId,
      oauthClientSecret: row.oauthClientSecret,
      oauthScope: row.oauthScope,
      oauthCallbackPort: row.oauthCallbackPort,
      catalogSlug: row.catalogSlug,
    };
  }
  const [row] = await db
    .select({
      config: mcpAppConfigs,
      pluginName: mcpServers.name,
      catalogSlug: mcpServers.catalogSlug,
    })
    .from(mcpAppConfigs)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpAppConfigs.serverId))
    .where(eq(mcpAppConfigs.id, ref.appConfigId));
  if (!row) return undefined;
  const { config } = row;
  return {
    connectionId,
    serverId: config.serverId,
    appConfigId: config.id,
    pluginName: row.pluginName,
    displayName: appConfigDisplayName(row.pluginName, config.name),
    transport: config.transport,
    command: config.command,
    args: config.args,
    envJson: null,
    headersJson: null,
    envEncrypted: config.envEncrypted,
    headersEncrypted: config.headersEncrypted,
    url: config.url,
    oauthEnabled: config.oauthEnabled,
    oauthState: config.oauthState,
    oauthClientId: config.oauthClientId,
    oauthClientSecret: config.oauthClientSecret,
    oauthScope: config.oauthScope,
    oauthCallbackPort: config.oauthCallbackPort,
    catalogSlug: row.catalogSlug,
  };
}

export async function readMcpConnectionOAuthState(
  connectionId: number,
): Promise<string | null> {
  const ref = parseMcpConnectionId(connectionId);
  if (ref.kind === "plugin") {
    const [row] = await db
      .select({ oauthState: mcpServers.oauthState })
      .from(mcpServers)
      .where(eq(mcpServers.id, ref.serverId));
    return row?.oauthState ?? null;
  }
  const [row] = await db
    .select({ oauthState: mcpAppConfigs.oauthState })
    .from(mcpAppConfigs)
    .where(eq(mcpAppConfigs.id, ref.appConfigId));
  return row?.oauthState ?? null;
}

/** The OAuth columns the connection machinery itself writes. */
export interface McpConnectionOAuthColumns {
  oauthState?: string | null;
  oauthCallbackPort?: number | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
}

/** Writes OAuth columns of a connection. */
export async function writeMcpConnectionOAuthColumns(
  connectionId: number,
  values: McpConnectionOAuthColumns,
): Promise<void> {
  const ref = parseMcpConnectionId(connectionId);
  if (ref.kind === "plugin") {
    await db
      .update(mcpServers)
      .set(values)
      .where(eq(mcpServers.id, ref.serverId));
    return;
  }
  await db
    .update(mcpAppConfigs)
    .set(values)
    .where(eq(mcpAppConfigs.id, ref.appConfigId));
}

/**
 * Writes a connection's OAuth client, but only while the row is still an
 * http configuration with OAuth on, so an edit that landed in between is
 * not overwritten. Returns whether a row was written.
 */
export async function writeMcpConnectionOAuthClientIfHttpOAuth(
  connectionId: number,
  values: Pick<
    McpConnectionOAuthColumns,
    "oauthClientId" | "oauthClientSecret"
  >,
): Promise<boolean> {
  const ref = parseMcpConnectionId(connectionId);
  if (ref.kind === "plugin") {
    const written = await db
      .update(mcpServers)
      .set(values)
      .where(
        and(
          eq(mcpServers.id, ref.serverId),
          eq(mcpServers.transport, "http"),
          eq(mcpServers.oauthEnabled, true),
        ),
      )
      .returning({ id: mcpServers.id });
    return written.length > 0;
  }
  const written = await db
    .update(mcpAppConfigs)
    .set(values)
    .where(
      and(
        eq(mcpAppConfigs.id, ref.appConfigId),
        eq(mcpAppConfigs.transport, "http"),
        eq(mcpAppConfigs.oauthEnabled, true),
      ),
    )
    .returning({ id: mcpAppConfigs.id });
  return written.length > 0;
}

/** The stored OAuth state of every configuration of a plugin. */
export async function listPluginOAuthStates(
  serverId: number,
): Promise<{ connectionId: number; oauthState: string | null }[]> {
  const [plugin, configs] = await Promise.all([
    db
      .select({ oauthState: mcpServers.oauthState })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId)),
    db
      .select({ id: mcpAppConfigs.id, oauthState: mcpAppConfigs.oauthState })
      .from(mcpAppConfigs)
      .where(eq(mcpAppConfigs.serverId, serverId)),
  ]);
  return [
    ...plugin.map((row) => ({
      connectionId: serverId,
      oauthState: row.oauthState,
    })),
    ...configs.map((row) => ({
      connectionId: appConfigConnectionId(row.id),
      oauthState: row.oauthState,
    })),
  ];
}
