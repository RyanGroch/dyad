import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

// Shared OAuth 2.0 + PKCE helper for MCP server specs whose backend
// requires OAuth instead of an API key (Linear, Notion, Atlassian, …).
//
// Flow per spec invocation:
//   1. Check cache (~/.cache/dyad-eval/oauth/<cacheKey>.json). If valid
//      and unexpired, return the cached `access_token`.
//   2. Otherwise: spin up a loopback HTTP listener on a configured port,
//      build the authorization URL with PKCE S256 challenge, print it
//      and try to open it in the user's default browser, await the OAuth
//      provider's callback hit, exchange `code` for `access_token` at
//      the token endpoint, cache it, return it.
//
// Non-interactive environments (no TTY, no `EVAL_OAUTH_AUTO=1`) abort
// before opening any URL so CI runs and `vitest run` never wedge waiting
// on a human. Callers (typically `McpServerSpec.probe`) check `isTTY`
// themselves and produce a clean skip reason when interactive auth
// isn't possible.

const CACHE_ROOT = resolve(
  process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"),
  "dyad-eval",
  "oauth",
);

export interface OAuthConfig {
  /**
   * Stable key — used as the cache filename and shown in CLI prompts.
   * Match it to the spec key (e.g. `linear`).
   */
  cacheKey: string;
  /** Human-readable display name shown in CLI prompts. */
  displayName: string;
  /** Full URL of the authorization endpoint (where the user logs in). */
  authorizationEndpoint: string;
  /** Full URL of the token endpoint (POST code → access_token). */
  tokenEndpoint: string;
  /** OAuth client_id registered with the upstream provider. */
  clientId: string;
  /**
   * Optional client_secret. Public clients using PKCE typically don't
   * need one; confidential clients do. Forwarded as `client_secret`
   * form param when set.
   */
  clientSecret?: string;
  /** Space-separated scopes string sent to the auth endpoint. */
  scope: string;
  /**
   * Loopback port the local callback listener binds to. Must match a
   * redirect_uri registered with the upstream OAuth app, since most
   * providers require redirect URIs to be pre-registered with an exact
   * port. The full redirect URI is `http://localhost:<port>/callback`.
   */
  callbackPort: number;
}

export interface CachedToken {
  /** Access token to send as `Authorization: Bearer <token>`. */
  accessToken: string;
  /** Optional refresh token (some providers issue them, others don't). */
  refreshToken?: string;
  /**
   * Absolute epoch ms when this token expires. `0` means "unknown" —
   * loader treats unknown-expiry tokens as valid (provider didn't tell
   * us, so trust until it 401s and we force-refresh).
   */
  expiresAtMs: number;
  /** Approximate token type (usually `Bearer`). */
  tokenType: string;
}

function cachePath(cacheKey: string): string {
  // Restrict to a safe subset of characters so a malicious cacheKey
  // can't traverse out of CACHE_ROOT.
  const safe = cacheKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return resolve(CACHE_ROOT, `${safe}.json`);
}

export function loadCachedToken(cacheKey: string): CachedToken | null {
  const path = cachePath(cacheKey);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CachedToken;
    if (typeof parsed.accessToken !== "string") return null;
    if (parsed.expiresAtMs > 0 && parsed.expiresAtMs < Date.now() + 30_000) {
      // Within 30s of expiry — treat as expired so the next call goes
      // through the full auth flow. 30s buffer absorbs clock skew + the
      // time the eval run will take.
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveCachedToken(cacheKey: string, token: CachedToken): void {
  const path = cachePath(cacheKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(token, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function clearCachedToken(cacheKey: string): void {
  const path = cachePath(cacheKey);
  if (existsSync(path)) {
    try {
      writeFileSync(path, "");
    } catch {
      // best effort
    }
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(
    createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

/**
 * Best-effort browser launcher. Picks the platform's default opener
 * (`xdg-open` / `open` / `start`) and detaches the spawned process so
 * the eval suite never blocks on it. If no opener is available, the
 * caller falls back to printing the URL — which is fine because we've
 * already printed it before calling this.
 */
function tryOpenBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    child.on("error", () => {
      // Opener missing on the host — caller's printed URL still works.
    });
  } catch {
    // Same fallback.
  }
}

interface AuthCallbackResult {
  code: string;
  state: string;
}

/**
 * Bind a one-shot HTTP listener that resolves on the first
 * `/callback?code=...&state=...` hit, with a configurable timeout.
 * The listener serves a brief success page so the user knows they
 * can close the browser tab.
 */
async function awaitCallback(
  port: number,
  expectedState: string,
  timeoutMs: number,
): Promise<AuthCallbackResult> {
  return new Promise<AuthCallbackResult>((resolveCb, rejectCb) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "", `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(
          `<html><body><h2>Authentication failed</h2><p>${error}</p></body></html>`,
        );
        cleanup();
        rejectCb(
          new Error(
            `OAuth provider returned error: ${error}${url.searchParams.get("error_description") ? ` (${url.searchParams.get("error_description")})` : ""}`,
          ),
        );
        return;
      }
      if (!code || !state) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Missing code or state");
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("State mismatch");
        cleanup();
        rejectCb(new Error("OAuth state parameter did not match"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<html><body><h2>Authentication complete.</h2><p>You can close this tab and return to the terminal.</p></body></html>",
      );
      cleanup();
      resolveCb({ code, state });
    });

    const timer = setTimeout(() => {
      cleanup();
      rejectCb(
        new Error(
          `OAuth callback did not arrive within ${timeoutMs}ms — was the auth flow completed in the browser?`,
        ),
      );
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (err) => {
      cleanup();
      rejectCb(
        new Error(
          `Failed to bind OAuth callback listener on port ${port}: ${err.message}. Is another process using that port?`,
        ),
      );
    });
    server.listen(port, "127.0.0.1");
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

async function exchangeCodeForToken(params: {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  if (params.clientSecret) body.set("client_secret", params.clientSecret);

  const res = await fetch(params.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token endpoint returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Return an access token for the configured OAuth provider, prompting
 * the user via the terminal if no cached token is available. Subsequent
 * calls within the cache window return without prompting. Throws if the
 * environment isn't interactive (no TTY) — callers should detect that
 * up front in their `probe()` and surface a clean skip reason.
 */
export async function getOAuthToken(config: OAuthConfig): Promise<string> {
  const cached = loadCachedToken(config.cacheKey);
  if (cached) return cached.accessToken;

  if (!process.stdin.isTTY && process.env.EVAL_OAUTH_AUTO !== "1") {
    throw new Error(
      `No cached OAuth token for "${config.cacheKey}" and current process is not a TTY. ` +
        `Run the eval interactively once to acquire a token, or set EVAL_OAUTH_AUTO=1 if a token will be supplied by other means.`,
    );
  }

  const { verifier, challenge } = generatePkcePair();
  const state = base64UrlEncode(randomBytes(16));
  const redirectUri = `http://localhost:${config.callbackPort}/callback`;

  const authUrl = new URL(config.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", config.scope);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log(
    `\n┌────────────────────────────────────────────────────────────────┐\n` +
      `│ ${config.displayName} OAuth required\n` +
      `├────────────────────────────────────────────────────────────────┤\n` +
      `│ Open this URL to authenticate, then return here:\n` +
      `│\n│   ${authUrl.toString()}\n│\n` +
      `│ Listening for callback on ${redirectUri} ...\n` +
      `└────────────────────────────────────────────────────────────────┘\n`,
  );
  tryOpenBrowser(authUrl.toString());

  // Start the listener concurrently with browser open. 5min budget —
  // generous for "go grant a Linear app's permissions" but bounded so a
  // forgotten flow doesn't hang the eval indefinitely.
  const { code } = await awaitCallback(config.callbackPort, state, 5 * 60_000);

  const token = await exchangeCodeForToken({
    tokenEndpoint: config.tokenEndpoint,
    code,
    codeVerifier: verifier,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri,
  });

  const cachedToken: CachedToken = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAtMs:
      typeof token.expires_in === "number"
        ? Date.now() + token.expires_in * 1000
        : 0,
    tokenType: token.token_type ?? "Bearer",
  };
  saveCachedToken(config.cacheKey, cachedToken);

  console.log(
    `✓ ${config.displayName} OAuth complete. Token cached to ${cachePath(config.cacheKey)}\n`,
  );
  return cachedToken.accessToken;
}
