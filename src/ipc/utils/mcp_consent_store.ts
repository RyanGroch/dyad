import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { mcpAppConfigToolConsents, mcpToolConsents } from "../../db/schema";
import {
  appConfigConnectionId,
  parseMcpConnectionId,
} from "@/shared/mcp_connection_id";

export type Consent = "ask" | "always" | "denied";

export interface StoredToolConsent {
  id: number;
  /** Connection id: a plugin, or an app-specific configuration of one. */
  serverId: number;
  toolName: string;
  consent: Consent;
  updatedAt: Date;
}

/**
 * Tool approvals, by connection id. An app-specific configuration can reach
 * a different server or account than its plugin's default, so its
 * approvals are stored separately and never shared with the default's.
 */
export async function getStoredConsent(
  connectionId: number,
  toolName: string,
): Promise<Consent> {
  const ref = parseMcpConnectionId(connectionId);
  const rows =
    ref.kind === "plugin"
      ? await db
          .select({ consent: mcpToolConsents.consent })
          .from(mcpToolConsents)
          .where(
            and(
              eq(mcpToolConsents.serverId, ref.serverId),
              eq(mcpToolConsents.toolName, toolName),
            ),
          )
      : await db
          .select({ consent: mcpAppConfigToolConsents.consent })
          .from(mcpAppConfigToolConsents)
          .where(
            and(
              eq(mcpAppConfigToolConsents.appConfigId, ref.appConfigId),
              eq(mcpAppConfigToolConsents.toolName, toolName),
            ),
          );
  return (rows[0]?.consent as Consent | undefined) ?? "ask";
}

export async function setStoredConsent(
  connectionId: number,
  toolName: string,
  consent: Consent,
): Promise<StoredToolConsent> {
  const ref = parseMcpConnectionId(connectionId);
  if (ref.kind === "plugin") {
    const [row] = await db
      .insert(mcpToolConsents)
      .values({ serverId: ref.serverId, toolName, consent })
      .onConflictDoUpdate({
        target: [mcpToolConsents.serverId, mcpToolConsents.toolName],
        set: { consent },
      })
      .returning();
    return { ...row, consent: row.consent as Consent };
  }
  const [row] = await db
    .insert(mcpAppConfigToolConsents)
    .values({ appConfigId: ref.appConfigId, toolName, consent })
    .onConflictDoUpdate({
      target: [
        mcpAppConfigToolConsents.appConfigId,
        mcpAppConfigToolConsents.toolName,
      ],
      set: { consent },
    })
    .returning();
  return toStoredAppConfigConsent(row);
}

export async function listStoredConsents(): Promise<StoredToolConsent[]> {
  const [pluginRows, configRows] = await Promise.all([
    db.select().from(mcpToolConsents),
    db.select().from(mcpAppConfigToolConsents),
  ]);
  return [
    ...pluginRows.map((row) => ({ ...row, consent: row.consent as Consent })),
    ...configRows.map(toStoredAppConfigConsent),
  ];
}

function toStoredAppConfigConsent(
  row: typeof mcpAppConfigToolConsents.$inferSelect,
): StoredToolConsent {
  return {
    id: row.id,
    serverId: appConfigConnectionId(row.appConfigId),
    toolName: row.toolName,
    consent: row.consent as Consent,
    updatedAt: row.updatedAt,
  };
}
