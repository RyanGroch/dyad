import { createServer, type Server } from "node:http";
import log from "electron-log";
import { auth } from "@ai-sdk/mcp";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { mcpServers } from "../../db/schema";
import {
  DEFAULT_OAUTH_CALLBACK_PORT,
  DyadOAuthClientProvider,
  decryptFromString,
} from "./mcp_oauth_provider";
import { mcpManager } from "./mcp_manager";

const logger = log.scope("mcp_oauth_flow");

// Hard cap on how long we'll keep the loopback listener open waiting
// for the user to complete the browser-side consent. Beyond this we
// tear the listener down and surface an error -- otherwise a user who
// closes the tab silently would leak both the listener and the
// pending promise indefinitely.
const OAUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingFlow {
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  servers: Server[];
  timeout: NodeJS.Timeout;
  expectedState: string | null;
}

// At most one OAuth flow per port at a time. Concurrent flows on the
// same port can't bind the listener, so we serialize by port. Map key
// is the port number.
const pendingFlows = new Map<number, PendingFlow>();

function generateState(): string {
  // 16 random bytes -> 22-char base64url. Used as the OAuth `state`
  // parameter for CSRF protection: verified on callback before we
  // accept the `code`.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

// The hosts we attempt to bind the callback listener to. We have to
// bind BOTH IPv4 and IPv6 loopback addresses because modern OS
// resolvers (and browsers) often return `::1` first for `localhost`
// while the OAuth `redirect_uri` registered with the server is
// `http://localhost:<port>/callback`. Binding only `127.0.0.1` then
// has the browser hit `[::1]:<port>` -> nothing listening -> the user
// sees "connection refused" right after consent. We accept partial
// success (e.g. IPv6 disabled in the kernel) as long as at least one
// stack bound; the redirect will then reach whichever one the
// browser's resolver picks.
const LOOPBACK_BIND_HOSTS = ["127.0.0.1", "::1"] as const;

async function startCallbackListener(
  port: number,
  expectedState: string,
): Promise<string> {
  // Supersede any flow already pending on this port -- the user has
  // visibly clicked Connect again, so the older flow is dead from
  // their perspective. Reject the old promise so its `runOAuthFlow`
  // catches cleanly and disposes its provider state, then WAIT for
  // the sockets to actually finish closing before binding the new
  // listener (otherwise the new bind would race the old close and
  // either silently inherit the dangling socket or EADDRINUSE).
  const existing = pendingFlows.get(port);
  if (existing) {
    logger.info(
      `Superseding stale OAuth flow on port ${port} (new Connect attempt)`,
    );
    clearTimeout(existing.timeout);
    pendingFlows.delete(port);
    existing.reject(
      new Error("OAuth flow superseded by a new Connect attempt."),
    );
    await Promise.all(
      existing.servers.map(
        (s) =>
          new Promise<void>((resolveClose) => {
            // `close` won't fire if the server already errored / never
            // bound -- guard against indefinite hang.
            s.close(() => resolveClose());
            setTimeout(() => resolveClose(), 500);
          }),
      ),
    );
  }

  return new Promise<string>((resolve, reject) => {
    const servers: Server[] = [];

    const closeAllDeferred = () => {
      // Defer close so the browser receives the response body before
      // the listener tears down. Without this, some browsers show a
      // connection-reset error to the user.
      for (const s of servers) {
        setTimeout(() => s.close(), 100);
      }
    };

    const settle = (fn: () => void) => {
      const pending = pendingFlows.get(port);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingFlows.delete(port);
      }
      closeAllDeferred();
      fn();
    };

    const handler = (req: any, res: any): void => {
      if (!req.url) {
        res.writeHead(400).end("Bad request");
        return;
      }
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const errParam = url.searchParams.get("error");
      const state = url.searchParams.get("state");

      if (state !== expectedState) {
        res
          .writeHead(400, { "Content-Type": "text/html" })
          .end(
            "<html><body><h1>OAuth state mismatch</h1><p>This window can be closed; the flow will be retried.</p></body></html>",
          );
        settle(() =>
          reject(
            new Error(
              "OAuth callback `state` did not match. Aborting to prevent CSRF.",
            ),
          ),
        );
        return;
      }

      if (code) {
        res
          .writeHead(200, { "Content-Type": "text/html" })
          .end(
            "<html><body><h1>Authorization successful</h1><p>You can close this window and return to Dyad.</p></body></html>",
          );
        settle(() => resolve(code));
        return;
      }

      res
        .writeHead(400, { "Content-Type": "text/html" })
        .end(
          `<html><body><h1>OAuth error</h1><p>${errParam ?? "Missing code"}</p></body></html>`,
        );
      settle(() =>
        reject(
          new Error(`OAuth callback error: ${errParam ?? "missing code"}`),
        ),
      );
    };

    const tryBind = (host: string): Promise<Server | null> =>
      new Promise((resolveBind) => {
        const s = createServer(handler);
        const onError = (err: Error) => {
          logger.warn(
            `Could not bind OAuth callback listener on ${host}:${port}: ${err.message}`,
          );
          resolveBind(null);
        };
        s.once("error", onError);
        s.listen(port, host, () => {
          s.removeListener("error", onError);
          resolveBind(s);
        });
      });

    Promise.all(LOOPBACK_BIND_HOSTS.map(tryBind)).then((bindResults) => {
      const bound = bindResults.filter((s): s is Server => s !== null);
      if (bound.length === 0) {
        reject(
          new Error(
            `Could not bind OAuth callback listener on port ${port} (tried IPv4 and IPv6 loopback).`,
          ),
        );
        return;
      }
      servers.push(...bound);

      const timeout = setTimeout(() => {
        const pending = pendingFlows.get(port);
        if (pending) {
          pendingFlows.delete(port);
          closeAllDeferred();
          reject(
            new Error(
              `OAuth flow timed out after ${OAUTH_FLOW_TIMEOUT_MS / 1000}s. Did you close the browser tab?`,
            ),
          );
        }
      }, OAUTH_FLOW_TIMEOUT_MS);

      pendingFlows.set(port, {
        resolve,
        reject,
        servers,
        timeout,
        expectedState,
      });
      logger.info(
        `OAuth callback listener bound on http://localhost:${port} (${bound.length} stack${bound.length === 1 ? "" : "s"})`,
      );
    });
  });
}

interface RunOAuthFlowParams {
  serverId: number;
  callbackPort?: number;
  scope?: string;
}

/**
 * Drive the full OAuth dance against a configured MCP server. Returns
 * `{success: true}` when tokens land in storage and the `mcpServers`
 * row reflects the connection. Errors are surfaced as
 * `{success: false, error: <msg>}` rather than thrown so the renderer
 * can render them inline without crashing the IPC channel.
 */
export async function runOAuthFlow(
  params: RunOAuthFlowParams,
): Promise<{ success: boolean; error: string | null }> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, params.serverId));
  const s = rows[0];
  if (!s) {
    return {
      success: false,
      error: `MCP server not found: ${params.serverId}`,
    };
  }
  if (!s.url) {
    return {
      success: false,
      error: `MCP server "${s.name}" has no URL; OAuth requires HTTP or SSE transport.`,
    };
  }
  if (s.transport !== "http" && s.transport !== "sse") {
    return {
      success: false,
      error: `OAuth not supported for transport "${s.transport}".`,
    };
  }

  const callbackPort = params.callbackPort ?? DEFAULT_OAUTH_CALLBACK_PORT;
  // Some OAuth-gated MCP servers require an explicit `scope` parameter
  // in the authorize URL -- omitting it can surface as a misleading
  // "Invalid client" error rather than a missing-scope error. Read the
  // configured scope from the row, fall back to the caller's override,
  // and finally to "read" as a conservative default.
  const scope = s.oauthScope ?? params.scope ?? "read";
  // Decrypt the stored client_secret (if any) just in time so the
  // plaintext value never lives in the row payload that crosses the
  // IPC boundary. Empty string from decryptFromString means decryption
  // failed -- treat as absent rather than passing junk to the SDK.
  const decryptedClientSecret = s.oauthClientSecret
    ? decryptFromString(s.oauthClientSecret) || undefined
    : undefined;
  const expectedState = generateState();
  const provider = new DyadOAuthClientProvider({
    serverId: s.id,
    callbackPort,
    scope,
    preregisteredClientId: s.oauthClientId ?? undefined,
    preregisteredClientSecret: decryptedClientSecret,
    // Per-flow CSRF state value. Surfaced via `provider.state()`;
    // verified on the loopback callback against the same value.
    flowState: expectedState,
    // Only THIS flow path stood up a loopback listener, so it's the
    // only one allowed to actually open the system browser. The
    // `mcp_manager`-built providers default to non-interactive.
    allowInteractive: true,
  });

  // Start the listener BEFORE calling `auth()` -- `auth()` opens the
  // browser via `redirectToAuthorization`, and the user may complete
  // consent extremely quickly. We don't want a race where the
  // callback arrives before the listener is ready.
  const codePromise = startCallbackListener(callbackPort, expectedState);
  // Attach a no-op handler synchronously so an early rejection (e.g.
  // bind failure on both stacks) doesn't sit unhandled during the
  // long `await auth()` that follows. The real rejection still
  // propagates through `await codePromise` below; this side-handler
  // exists only to silence Node's unhandledRejection warning.
  codePromise.catch(() => undefined);

  try {
    // First call kicks off discovery / DCR if needed and opens the
    // browser via our provider's `redirectToAuthorization`. Returns
    // 'REDIRECT' when interactive consent is required. The `scope`
    // here lands in the authorize URL's `scope=` query parameter --
    // load-bearing for providers that require it.
    const initial = await auth(provider, {
      serverUrl: s.url,
      scope,
    });
    if (initial === "AUTHORIZED") {
      // Tokens were still valid (refresh succeeded silently). Nothing
      // more to do; tear the listener(s) down.
      const pending = pendingFlows.get(callbackPort);
      if (pending) {
        clearTimeout(pending.timeout);
        for (const sv of pending.servers) sv.close();
        pendingFlows.delete(callbackPort);
      }
      mcpManager.dispose(s.id);
      return { success: true, error: null };
    }

    const code = await codePromise;
    const final = await auth(provider, {
      serverUrl: s.url,
      authorizationCode: code,
      scope,
    });
    if (final !== "AUTHORIZED") {
      return {
        success: false,
        error: "OAuth completed without authorization; please try again.",
      };
    }

    // Force the cached MCP client to rebuild on next use so it picks
    // up the new tokens via the provider.
    mcpManager.dispose(s.id);
    return { success: true, error: null };
  } catch (err) {
    // Clean up the listener(s) if `auth()` threw before the callback
    // arrived (network failure, discovery 4xx, etc).
    const pending = pendingFlows.get(callbackPort);
    if (pending) {
      clearTimeout(pending.timeout);
      for (const sv of pending.servers) sv.close();
      pendingFlows.delete(callbackPort);
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`OAuth flow failed for server ${s.id}: ${message}`);
    return { success: false, error: message };
  }
}

export async function disconnectOAuth(
  serverId: number,
): Promise<{ success: boolean }> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  const s = rows[0];
  if (!s) return { success: false };
  const provider = new DyadOAuthClientProvider({
    serverId: s.id,
    preregisteredClientId: s.oauthClientId ?? undefined,
    preregisteredClientSecret: s.oauthClientSecret
      ? decryptFromString(s.oauthClientSecret) || undefined
      : undefined,
  });
  await provider.invalidateCredentials("all");
  mcpManager.dispose(serverId);
  return { success: true };
}
