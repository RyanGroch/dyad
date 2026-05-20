import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory store of `oauth_state` rows keyed by serverId. The mocked
// db's `update().set().where()` chain writes here; the mocked
// `select()` chain reads from here. Lets us exercise the real
// provider against a real DB-like surface without touching SQLite.
const dbStore = new Map<number, string | null>();

vi.mock("electron", () => ({
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, "utf8")),
    decryptString: vi.fn((buf: Buffer) => {
      const s = buf.toString("utf8");
      return s.startsWith("enc:") ? s.slice(4) : s;
    }),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock("../db", () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => {
          const id = currentTargetId;
          return Promise.resolve([{ oauthState: dbStore.get(id) ?? null }]);
        },
      }),
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const id = currentTargetId;
          dbStore.set(id, (values.oauthState as string | null) ?? null);
          return Promise.resolve([]);
        },
      }),
    })),
  },
}));

vi.mock("../db/schema", () => ({
  mcpServers: { id: "id", oauthState: "oauth_state" },
}));

// `eq()` from drizzle-orm normally returns a SQL fragment. The mocked
// db ignores it entirely, but `select().from().where(...)` still
// needs a value. Capture the serverId via a module-level pointer
// updated before each operation -- the provider always passes the
// same serverId to every query in a call chain, so this is safe.
let currentTargetId = 0;

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, value: number) => {
    currentTargetId = value;
    return { _col, value };
  },
}));

// Resolve electron mock so the provider's shell + safeStorage refs
// work; resolve the provider module after mocks are in place.
const electronImport = await import("electron");
const providerImport = await import("../ipc/utils/mcp_oauth_provider");
const { DyadOAuthClientProvider, _resetCodeVerifiersForTest } = providerImport;
const { shell, safeStorage } = electronImport;

describe("DyadOAuthClientProvider", () => {
  beforeEach(() => {
    dbStore.clear();
    _resetCodeVerifiersForTest();
    vi.clearAllMocks();
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
  });

  it("computes redirectUrl from the configured callback port", () => {
    const p = new DyadOAuthClientProvider({
      serverId: 1,
      callbackPort: 12345,
    });
    expect(p.redirectUrl).toBe("http://localhost:12345/callback");
  });

  it("defaults the redirectUrl to port 53682 when none is supplied", () => {
    const p = new DyadOAuthClientProvider({ serverId: 1 });
    expect(p.redirectUrl).toBe("http://localhost:53682/callback");
  });

  it("emits clientMetadata with Dyad-shaped fields", () => {
    const p = new DyadOAuthClientProvider({ serverId: 1, scope: "read" });
    const meta = p.clientMetadata;
    expect(meta.redirect_uris).toEqual(["http://localhost:53682/callback"]);
    expect(meta.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.response_types).toEqual(["code"]);
    expect(meta.client_name).toBe("Dyad");
    expect(meta.scope).toBe("read");
  });

  it("round-trips tokens through encrypted storage", async () => {
    const p = new DyadOAuthClientProvider({ serverId: 7 });
    expect(await p.tokens()).toBeUndefined();
    await p.saveTokens({
      access_token: "tok",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt",
    });
    const round = await p.tokens();
    expect(round).toEqual({
      access_token: "tok",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt",
    });
    // Storage went through encryptString — never the plaintext JSON.
    expect(safeStorage.encryptString).toHaveBeenCalled();
    const stored = dbStore.get(7);
    expect(stored).toBeDefined();
    expect(stored).not.toContain("tok");
  });

  it("seeds clientInformation from preregisteredClientId on first read", async () => {
    const p = new DyadOAuthClientProvider({
      serverId: 9,
      preregisteredClientId: "client-xyz",
    });
    const first = await p.clientInformation();
    expect(first?.client_id).toBe("client-xyz");
    // Seeded value is persisted so subsequent reads come from storage,
    // not from re-seeding (which would mask a saveClientInformation
    // call later overwriting it).
    expect(dbStore.get(9)).toBeDefined();
  });

  it("persists saveClientInformation and skips reseeding from preregistered id", async () => {
    const p = new DyadOAuthClientProvider({
      serverId: 11,
      preregisteredClientId: "from-config",
    });
    await p.saveClientInformation({
      client_id: "from-dcr",
      client_secret: "secret",
    });
    const got = await p.clientInformation();
    expect(got?.client_id).toBe("from-dcr");
    expect(got?.client_secret).toBe("secret");
  });

  it("holds the PKCE code verifier in memory only and never on disk", async () => {
    const p = new DyadOAuthClientProvider({ serverId: 3 });
    await p.saveCodeVerifier("the-verifier");
    expect(await p.codeVerifier()).toBe("the-verifier");
    // Storage row must NOT contain the verifier — that's the whole
    // point of keeping PKCE verifiers in-memory.
    expect(dbStore.get(3) ?? "").not.toContain("the-verifier");
  });

  it("throws when codeVerifier is requested without a prior save", async () => {
    const p = new DyadOAuthClientProvider({ serverId: 4 });
    await expect(p.codeVerifier()).rejects.toThrow(
      /No PKCE code verifier in memory/,
    );
  });

  it("opens the system browser when redirectToAuthorization is called in an interactive provider", async () => {
    const p = new DyadOAuthClientProvider({
      serverId: 1,
      allowInteractive: true,
    });
    await p.redirectToAuthorization(
      new URL("https://example.com/authorize?foo=bar"),
    );
    expect(shell.openExternal).toHaveBeenCalledWith(
      "https://example.com/authorize?foo=bar",
    );
  });

  it("refuses to open the browser when allowInteractive is not set", async () => {
    // Providers built by `mcp_manager` for ambient use must fail
    // closed rather than open a browser whose redirect would land at
    // a loopback port with nothing listening. The thrown error gets
    // surfaced as `UnauthorizedError` by the SDK and rendered as
    // "not connected" in the UI.
    const p = new DyadOAuthClientProvider({ serverId: 1 });
    await expect(
      p.redirectToAuthorization(new URL("https://example.com/authorize")),
    ).rejects.toThrow(/click Connect/);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  describe("addClientAuthentication", () => {
    it("uses Basic auth when token_endpoint_auth_method is client_secret_basic", async () => {
      const p = new DyadOAuthClientProvider({ serverId: 20 });
      await p.saveClientInformation({
        client_id: "cid",
        client_secret: "sec",
        // OAuthClientInformation does not type this field explicitly;
        // the SDK example reads it via a cast. We mirror that here.
        ...({ token_endpoint_auth_method: "client_secret_basic" } as object),
      } as Parameters<typeof p.saveClientInformation>[0]);
      const headers = new Headers();
      const params = new URLSearchParams();
      await p.addClientAuthentication(headers, params);
      const expected = "Basic " + Buffer.from("cid:sec").toString("base64");
      expect(headers.get("Authorization")).toBe(expected);
      expect(params.get("client_id")).toBeNull();
    });

    it("posts client_id + client_secret as body params for client_secret_post", async () => {
      const p = new DyadOAuthClientProvider({ serverId: 21 });
      await p.saveClientInformation({
        client_id: "cid",
        client_secret: "sec",
        ...({ token_endpoint_auth_method: "client_secret_post" } as object),
      } as Parameters<typeof p.saveClientInformation>[0]);
      const headers = new Headers();
      const params = new URLSearchParams();
      await p.addClientAuthentication(headers, params);
      expect(headers.get("Authorization")).toBeNull();
      expect(params.get("client_id")).toBe("cid");
      expect(params.get("client_secret")).toBe("sec");
    });

    it("uses public PKCE (no secret) when the client has no secret", async () => {
      const p = new DyadOAuthClientProvider({ serverId: 22 });
      await p.saveClientInformation({ client_id: "cid" });
      const headers = new Headers();
      const params = new URLSearchParams();
      await p.addClientAuthentication(headers, params);
      expect(headers.get("Authorization")).toBeNull();
      expect(params.get("client_id")).toBe("cid");
      expect(params.get("client_secret")).toBeNull();
    });
  });

  describe("invalidateCredentials", () => {
    async function seedFull(serverId: number) {
      const p = new DyadOAuthClientProvider({ serverId });
      await p.saveTokens({ access_token: "t", token_type: "Bearer" });
      await p.saveClientInformation({ client_id: "c" });
      await p.saveCodeVerifier("v");
      return p;
    }

    it("clears only tokens for scope=tokens", async () => {
      const p = await seedFull(30);
      await p.invalidateCredentials("tokens");
      expect(await p.tokens()).toBeUndefined();
      expect((await p.clientInformation())?.client_id).toBe("c");
      expect(await p.codeVerifier()).toBe("v");
    });

    it("clears only client info for scope=client", async () => {
      const p = await seedFull(31);
      await p.invalidateCredentials("client");
      expect((await p.tokens())?.access_token).toBe("t");
      expect(await p.clientInformation()).toBeUndefined();
      expect(await p.codeVerifier()).toBe("v");
    });

    it("clears only the in-memory verifier for scope=verifier", async () => {
      const p = await seedFull(32);
      await p.invalidateCredentials("verifier");
      expect((await p.tokens())?.access_token).toBe("t");
      expect((await p.clientInformation())?.client_id).toBe("c");
      await expect(p.codeVerifier()).rejects.toThrow();
    });

    it("clears everything for scope=all", async () => {
      const p = await seedFull(33);
      await p.invalidateCredentials("all");
      expect(await p.tokens()).toBeUndefined();
      expect(await p.clientInformation()).toBeUndefined();
      await expect(p.codeVerifier()).rejects.toThrow();
    });
  });

  it("falls back to base64-only storage when safeStorage encryption is unavailable", async () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
    const p = new DyadOAuthClientProvider({ serverId: 99 });
    await p.saveTokens({ access_token: "fallback-tok", token_type: "Bearer" });
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    // Round-trip still works (decrypt path also falls back).
    const got = await p.tokens();
    expect(got?.access_token).toBe("fallback-tok");
  });
});
