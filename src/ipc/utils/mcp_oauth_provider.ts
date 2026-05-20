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
  const blob = encryptToString(JSON.stringify(state));
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
}

export class DyadOAuthClientProvider implements OAuthClientProvider {
  private readonly serverId: number;
  private readonly callbackPort: number;
  private readonly scope: string | undefined;
  private readonly preregisteredClientId: string | undefined;

  constructor(config: ProviderConfig) {
    this.serverId = config.serverId;
    this.callbackPort = config.callbackPort ?? DEFAULT_OAUTH_CALLBACK_PORT;
    this.scope = config.scope;
    this.preregisteredClientId = config.preregisteredClientId;
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
    // Hand the URL off to the user's default browser. Main process only
    // (renderer cannot invoke `shell`). The flow continues when the
    // loopback callback handler captures the `code` and re-invokes
    // `auth()` with it.
    logger.info(
      `Opening browser for OAuth: ${authorizationUrl.origin}${authorizationUrl.pathname}`,
    );
    await shell.openExternal(authorizationUrl.toString());
  }

  async addClientAuthentication(
    headers: Headers,
    params: URLSearchParams,
  ): Promise<void> {
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
  }

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
