import log from "electron-log";
import { supabaseSelfHostedAuthHeaders } from "./supabase_self_hosted_client";
import {
  readSupabaseSelfHostedMailSettings,
  type SupabaseSelfHostedMailSettings,
} from "./supabase_self_hosted_functions";
import type { SupabaseSelfHostedInstance } from "./supabase_self_hosted_store";

const logger = log.scope("supabase_self_hosted_email");

const SETTINGS_TIMEOUT_MS = 10_000;

/**
 * What Dyad can tell about an instance's email, read fresh each time because
 * the user can change their server at any moment. "configured" means a mail
 * server is set, not that its emails arrive: only a real send shows that.
 */
export type SupabaseSelfHostedEmailStatus =
  | { kind: "autoconfirm" }
  | { kind: "not-configured" }
  | { kind: "configured"; host: string }
  | { kind: "unknown" };

/**
 * A host without a dot is a container name. One that isn't running is the
 * install's placeholder (upstream's `supabase-mail`), so sends fail.
 */
function isPlaceholderHost(host: string, runningNames: string[]): boolean {
  return (
    !host.includes(".") && !host.includes(":") && !runningNames.includes(host)
  );
}

export function supabaseSelfHostedEmailStatusFrom({
  autoconfirm,
  mail,
}: {
  /** From the public auth settings; null when they couldn't be read. */
  autoconfirm: boolean | null;
  /** From the server over SSH; null without SSH or when it failed. */
  mail: SupabaseSelfHostedMailSettings | null;
}): SupabaseSelfHostedEmailStatus {
  if (autoconfirm === true || mail?.autoconfirm) return { kind: "autoconfirm" };
  if (!mail) return { kind: "unknown" };
  if (!mail.smtpHost || isPlaceholderHost(mail.smtpHost, mail.runningNames)) {
    return { kind: "not-configured" };
  }
  return { kind: "configured", host: mail.smtpHost };
}

async function readAutoconfirm(
  instance: SupabaseSelfHostedInstance,
): Promise<boolean | null> {
  try {
    const response = await fetch(`${instance.url}/auth/v1/settings`, {
      headers: supabaseSelfHostedAuthHeaders(instance.anonKey),
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { mailer_autoconfirm?: unknown };
    return typeof body.mailer_autoconfirm === "boolean"
      ? body.mailer_autoconfirm
      : null;
  } catch (error) {
    logger.warn("Could not read the instance's auth settings", error);
    return null;
  }
}

async function readMail(
  instance: SupabaseSelfHostedInstance,
): Promise<SupabaseSelfHostedMailSettings | null> {
  if (!instance.ssh) return null;
  try {
    return await readSupabaseSelfHostedMailSettings({
      instance: { id: instance.id, ssh: instance.ssh },
    });
  } catch (error) {
    logger.warn("Could not read the instance's mail settings", error);
    return null;
  }
}

export async function getSupabaseSelfHostedEmailStatus(
  instance: SupabaseSelfHostedInstance,
): Promise<SupabaseSelfHostedEmailStatus> {
  const [autoconfirm, mail] = await Promise.all([
    readAutoconfirm(instance),
    readMail(instance),
  ]);
  return supabaseSelfHostedEmailStatusFrom({ autoconfirm, mail });
}
