/**
 * One id space for every MCP configuration Dyad can connect to.
 *
 * A plugin's default configuration is its `mcp_servers` row and keeps that
 * row's (positive) id. An app-specific configuration lives in
 * `mcp_app_configs` and is addressed by the negated id of its row. Sharing
 * one numeric space lets the connection cache, the OAuth flow, tool
 * listings and tool approvals handle both kinds without a second set of
 * code paths; only the storage layer (`mcp_connection_store.ts`) needs to
 * know which table an id belongs to.
 */

export type McpConnectionRef =
  | { kind: "plugin"; serverId: number }
  | { kind: "app-config"; appConfigId: number };

export function appConfigConnectionId(appConfigId: number): number {
  if (!Number.isSafeInteger(appConfigId) || appConfigId <= 0) {
    throw new Error(`Invalid app configuration id: ${appConfigId}`);
  }
  return -appConfigId;
}

export function parseMcpConnectionId(connectionId: number): McpConnectionRef {
  if (!Number.isSafeInteger(connectionId) || connectionId === 0) {
    throw new Error(`Invalid MCP connection id: ${connectionId}`);
  }
  return connectionId > 0
    ? { kind: "plugin", serverId: connectionId }
    : { kind: "app-config", appConfigId: -connectionId };
}

export function isAppConfigConnectionId(connectionId: number): boolean {
  return connectionId < 0;
}
