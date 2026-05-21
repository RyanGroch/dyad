import { shell, safeStorage } from "electron";
import log from "electron-log";
import { eq } from "drizzle-orm";
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from "@ai-sdk/mcp";
import { db } from "../../db";
import { mcpServers } from "../../db/schema";

const logger = log.scope("mcp_oauth_provider");

// Default loopback port for the OAuth callback listener. Overridable
// per provider construction so users who pre-registered an OAuth app
// against a different localhost port can configure it without code
// changes.
export const DEFAULT_OAUTH_CALLBACK_PORT = 53682;

// Stored shape of `oauth_state` (after decryption). Both fields are
// optional because the SDK fills them at different points in the flow.
interface StoredOAuthState {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformation;
}

// PKCE code verifiers are flow-scoped secrets that must never touch
// disk -- holding them in a process-memory map keyed by serverId
// ensures they die with the process even if the DB file leaks.
const codeVerifiers = new Map<number, string>();

// Exported so `mcp_handlers` / `mcp_oauth_flow` can encrypt the
// `oauth_client_secret` column at the boundary without re-implementing
// the safeStorage fallback. Same byte shape as the `oauth_state`
// column so existing diagnostics treat both consistently.
export function encryptToString(plaintext: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // Platforms without a configured keyring (e.g. Linux without
    // libsecret) fall through to plaintext. We log a warning so the
    // user knows their tokens are stored as plaintext; refusing
    // outright would prevent OAuth from working at all on those
    // setups, which is a worse UX. A future flag could let users
    // opt out of the fallback.
    logger.warn(
      "safeStorage encryption unavailable; OAuth state written as plaintext",
    );
    return Buffer.from(plaintext, "utf8").toString("base64");
  }
  return safeStorage.encryptString(plaintext).toString("base64");
}

export function decryptFromString(stored: string): string {
  const buf = Buffer.from(stored, "base64");
  if (!safeStorage.isEncryptionAvailable()) {
    return buf.toString("utf8");
  }
  try {
    return safeStorage.decryptString(buf);
  } catch (err) {
    // Most common cause: state written on a different machine /
    // profile, or platform-keychain reset. Surfacing as "no stored
    // state" forces a fresh OAuth flow rather than crashing.
    logger.warn("Failed to decrypt OAuth state; treating as empty", err);
    return "";
  }
}

// Whether an encrypted oauth_state blob contains usable access tokens.
// `oauthState` may be populated with only `clientInformation` (e.g.
// after DCR succeeds during an ambient transport build but before the
// interactive consent step runs), so a non-null column value is NOT
// proof of a working connection. Callers use this to drive the
// "OAuth: connected" UI badge.
export function oauthStateHasTokens(stored: string | null): boolean {
  if (!stored) return false;
  const json = decryptFromString(stored);
  if (!json) return false;
  try {
    const parsed = JSON.parse(json) as StoredOAuthState;
    return Boolean(parsed.tokens?.access_token);
  } catch {
    return false;
  }
}

async function readState(serverId: number): Promise<StoredOAuthState> {
  const rows = await db
    .select({ oauthState: mcpServers.oauthState })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  const raw = rows[0]?.oauthState;
  if (!raw) return {};
  const json = decryptFromString(raw);
  if (!json) return {};
  try {
    return JSON.parse(json) as StoredOAuthState;
  } catch {
    return {};
  }
}

async function writeState(
  serverId: number,
  state: StoredOAuthState,
): Promise<void> {
  // When the state has no tokens AND no client info, write NULL
  // rather than an encrypted empty object so the column reflects "no
  // stored OAuth material at all" -- keeps DB inspection unambiguous
  // and avoids storing meaningless encrypted blobs.
  const isEmpty = !state.tokens && !state.clientInformation;
  const blob = isEmpty ? null : encryptToString(JSON.stringify(state));
  await db
    .update(mcpServers)
    .set({ oauthState: blob })
    .where(eq(mcpServers.id, serverId));
}

interface ProviderConfig {
  serverId: number;
  callbackPort?: number;
  scope?: string;
  // Pre-registered client_id for servers that do NOT support dynamic
  // client registration (RFC 7591). When provided we seed
  // `clientInformation` on first use so `auth()` skips the `/register`
  // step entirely.
  preregisteredClientId?: string;
  // Pre-registered client_secret for confidential OAuth clients (e.g.
  // GitHub OAuth Apps, Spotify, Reddit). Only meaningful alongside
  // `preregisteredClientId`. When present, `clientMetadata` declares
  // `token_endpoint_auth_method: "client_secret_post"` and
  // `addClientAuthentication` sends both id + secret on the token
  // exchange; when absent, the provider behaves as a public PKCE
  // client as before.
  preregisteredClientSecret?: string;
  // Per-flow CSRF state. Surfaced via `state()` so the SDK puts it
  // in the authorize URL; the loopback listener verifies the same
  // value on callback. Optional because internal SDK auth calls
  // (e.g. on transport connect) don't have an application-supplied
  // state, in which case the SDK falls back to its own generation.
  flowState?: string;
  // Whether this provider instance is allowed to open the system
  // browser for interactive OAuth consent. Only the explicit
  // Connect-button flow sets this to true (because it also stands
  // up the loopback callback listener). Providers constructed for
  // ambient use -- e.g. `mcp_manager` building a transport for
  // tool listing -- pass false so they fail closed with
  // `UnauthorizedError` instead of opening a browser whose redirect
  // would have nowhere to land.
  allowInteractive?: boolean;
}

export class DyadOAuthClientProvider implements OAuthClientProvider {
  private readonly serverId: number;
  private readonly callbackPort: number;
  private readonly scope: string | undefined;
  private readonly preregisteredClientId: string | undefined;
  private readonly preregisteredClientSecret: string | undefined;
  private readonly flowState: string | undefined;
  private readonly allowInteractive: boolean;
  // In-memory mirror of the most recently-read clientInformation so
  // `addClientAuthentication` can be invoked SYNCHRONOUSLY without
  // re-hitting the database. The SDK's exchangeAuthorization /
  // refreshAuthorization paths call `addClientAuthentication(...)`
  // WITHOUT awaiting its return value (see @ai-sdk/mcp index.js:807):
  // if our method yields on a DB read, the SDK fires the token
  // request with no client_id in the body, and the upstream OAuth
  // server rejects with `invalid_client: "Client ID is required"`.
  // Always populate this cache before `addClientAuthentication`
  // could be called -- both `clientInformation()` and
  // `saveClientInformation()` write to it.
  private cachedClientInformation: OAuthClientInformation | undefined;

  constructor(config: ProviderConfig) {
    this.serverId = config.serverId;
    this.callbackPort = config.callbackPort ?? DEFAULT_OAUTH_CALLBACK_PORT;
    this.scope = config.scope;
    this.preregisteredClientId = config.preregisteredClientId;
    this.preregisteredClientSecret = config.preregisteredClientSecret;
    this.flowState = config.flowState;
    this.allowInteractive = config.allowInteractive ?? false;
  }

  // The SDK calls `provider.state()` (if present) when building the
  // authorize URL. Real method on the prototype so it survives
  // through any bundling -- earlier attempt to assign this property
  // dynamically after construction silently failed in the prod
  // bundle, producing URLs without a `state` parameter. Returns
  // empty string when no flow state is configured so the SDK's
  // truthy check skips the `state=` parameter in that case.
  state(): string {
    return this.flowState ?? "";
  }

  get redirectUrl(): string {
    return `http://localhost:${this.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    // Declare auth method based on whether the user supplied a
    // `client_secret`. Default is public PKCE ("none"); declaring
    // "client_secret_post" on a public client misleads DCR servers
    // into expecting a secret on the token exchange and rejecting
    // with invalid_client. For confidential clients (e.g. GitHub
    // OAuth Apps) the opposite is true: declaring "none" while
    // sending a secret would also confuse the server. Pick based
    // on stored state.
    const tokenEndpointAuthMethod = this.preregisteredClientSecret
      ? "client_secret_post"
      : "none";
    return {
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      client_name: "Dyad",
      scope: this.scope,
    };
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const state = await readState(this.serverId);
    return state.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const state = await readState(this.serverId);
    state.tokens = tokens;
    await writeState(this.serverId, state);
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const state = await readState(this.serverId);
    if (state.clientInformation) {
      this.cachedClientInformation = state.clientInformation;
      return state.clientInformation;
    }
    // First-use seed for pre-registered (non-DCR) servers. Persisting
    // here avoids the `/register` round-trip on every flow. When the
    // user also configured a `client_secret`, seed that too -- the
    // SDK's `addClientAuthentication` reads both off the stored
    // clientInformation.
    if (this.preregisteredClientId) {
      const seeded: OAuthClientInformation = {
        client_id: this.preregisteredClientId,
        ...(this.preregisteredClientSecret
          ? { client_secret: this.preregisteredClientSecret }
          : {}),
      };
      await writeState(this.serverId, { ...state, clientInformation: seeded });
      this.cachedClientInformation = seeded;
      return seeded;
    }
    this.cachedClientInformation = undefined;
    return undefined;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformation,
  ): Promise<void> {
    // Cache synchronously BEFORE the DB write returns -- the SDK's
    // exchangeAuthorization path may invoke addClientAuthentication
    // without yielding, and that path needs `cachedClientInformation`
    // populated.
    this.cachedClientInformation = clientInformation;
    const state = await readState(this.serverId);
    state.clientInformation = clientInformation;
    await writeState(this.serverId, state);
  }

  async codeVerifier(): Promise<string> {
    const v = codeVerifiers.get(this.serverId);
    if (!v) {
      throw new Error(
        `No PKCE code verifier in memory for MCP server ${this.serverId}; the OAuth flow must be restarted.`,
      );
    }
    return v;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    codeVerifiers.set(this.serverId, codeVerifier);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Only the explicit Connect-button flow (via `runOAuthFlow`)
    // sets `allowInteractive: true`, because only that path stands
    // up the loopback callback listener. Providers constructed by
    // `mcp_manager` for ambient use (transport build during list-
    // tools, on-demand tool calls, etc.) MUST NOT open a browser --
    // any redirect would land at a localhost port with nothing
    // listening, producing the user-facing "localhost can't connect"
    // failure. Refuse the redirect here so the SDK surfaces an
    // `UnauthorizedError` to the caller, which the UI renders as a
    // "not connected" badge and prompts the user to click Connect.
    if (!this.allowInteractive) {
      throw new Error(
        "OAuth not currently allowed (interactive consent required; click Connect on the server row).",
      );
    }
    logger.info(
      `Opening browser for OAuth: ${authorizationUrl.origin}${authorizationUrl.pathname}`,
    );
    await shell.openExternal(authorizationUrl.toString());
  }

  // SYNCHRONOUS arrow-function field. Two binding considerations
  // baked in:
  //   1. The SDK passes this around as a bare function reference
  //      (`addClientAuthentication: provider.addClientAuthentication`)
  //      and invokes it without going through the receiver. Arrow-
  //      function field => `this` is captured lexically and survives.
  //   2. The SDK invokes it WITHOUT `await`
  //      (@ai-sdk/mcp index.js:807). If the function is async and
  //      yields on a DB read, the SDK fires the token-endpoint POST
  //      before client_id lands in `params`, and the upstream server
  //      rejects with `invalid_client: Client ID is required`. So we
  //      read `cachedClientInformation` synchronously instead of
  //      awaiting `this.clientInformation()`.
  addClientAuthentication = (
    headers: Headers,
    params: URLSearchParams,
  ): void => {
    const info = this.cachedClientInformation;
    if (!info) {
      logger.warn(
        `addClientAuthentication invoked without cached clientInformation for MCP server ${this.serverId}; token exchange will fail.`,
      );
      return;
    }
    const method = (
      info as OAuthClientInformation & { token_endpoint_auth_method?: string }
    ).token_endpoint_auth_method;
    const hasSecret = Boolean(info.client_secret);
    const chosen = method ?? (hasSecret ? "client_secret_post" : "none");

    if (chosen === "client_secret_basic") {
      if (!info.client_secret) {
        params.set("client_id", info.client_id);
        return;
      }
      const credentials = Buffer.from(
        `${info.client_id}:${info.client_secret}`,
      ).toString("base64");
      headers.set("Authorization", `Basic ${credentials}`);
      return;
    }

    if (chosen === "client_secret_post") {
      params.set("client_id", info.client_id);
      if (info.client_secret) params.set("client_secret", info.client_secret);
      return;
    }

    // Public PKCE client: no secret to send, just the client_id.
    params.set("client_id", info.client_id);
  };

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier",
  ): Promise<void> {
    logger.debug(
      `invalidateCredentials(${scope}) for MCP server ${this.serverId}`,
    );
    if (scope === "all" || scope === "verifier") {
      codeVerifiers.delete(this.serverId);
    }
    if (scope === "verifier") return;
    const state = await readState(this.serverId);
    if (scope === "all" || scope === "tokens") {
      delete state.tokens;
    }
    if (scope === "all" || scope === "client") {
      delete state.clientInformation;
      this.cachedClientInformation = undefined;
    }
    await writeState(this.serverId, state);
  }
}

// Test seam: lets unit tests clear the per-process code-verifier map
// without spinning up the whole provider lifecycle.
export function _resetCodeVerifiersForTest(): void {
  codeVerifiers.clear();
}
