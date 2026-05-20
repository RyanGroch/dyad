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

// Default loopback port for the OAuth callback listener. Matches the
// eval-suite default so users who pre-registered a Linear OAuth app
// against `http://localhost:53682/callback` don't need to re-register.
// Overridable per provider construction.
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

function encryptToString(plaintext: string): string {
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

function decryptFromString(stored: string): string {
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
  // rather than an encrypted empty object. The UI derives
  // `oauthConnected` from `oauthState IS NOT NULL`, so encoding an
  // empty state as a non-null encrypted blob would leave the
  // Disconnect button stuck on after invalidateCredentials("all")
  // -- the user could never get back to Connect without a manual
  // DB reset.
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
  private readonly flowState: string | undefined;
  private readonly allowInteractive: boolean;

  constructor(config: ProviderConfig) {
    this.serverId = config.serverId;
    this.callbackPort = config.callbackPort ?? DEFAULT_OAUTH_CALLBACK_PORT;
    this.scope = config.scope;
    this.preregisteredClientId = config.preregisteredClientId;
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
    return {
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
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
    if (state.clientInformation) return state.clientInformation;
    // First-use seed for pre-registered (non-DCR) servers. Persisting
    // here avoids the `/register` round-trip on every flow.
    if (this.preregisteredClientId) {
      const seeded: OAuthClientInformation = {
        client_id: this.preregisteredClientId,
      };
      await writeState(this.serverId, { ...state, clientInformation: seeded });
      return seeded;
    }
    return undefined;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformation,
  ): Promise<void> {
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

  // Declared as an arrow-function field (not a method) so the SDK
  // can pass it around as a bare function reference without losing
  // `this`. The SDK invokes it via
  // `addClientAuthentication(headers, params, url, metadata)` --
  // never as `provider.addClientAuthentication(...)` -- so a normal
  // method definition would lose its binding and crash with
  // "Cannot read properties of undefined (reading 'clientInformation')".
  // This pattern mirrors Vercel's PR 9127 example provider.
  addClientAuthentication = async (
    headers: Headers,
    params: URLSearchParams,
  ): Promise<void> => {
    const info = await this.clientInformation();
    if (!info) return;
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
    }
    await writeState(this.serverId, state);
  }
}

// Test seam: lets unit tests clear the per-process code-verifier map
// without spinning up the whole provider lifecycle.
export function _resetCodeVerifiersForTest(): void {
  codeVerifiers.clear();
}
