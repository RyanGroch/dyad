// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory replacement for the `mcp_servers` table. The mocked db
// reads/writes from here so we can exercise the flow without spinning
// up SQLite. Keyed by serverId; values are partial DB rows.
type Row = {
  id: number;
  name: string;
  transport: "stdio" | "http" | "sse";
  url: string | null;
  oauthEnabled: boolean;
  oauthClientId: string | null;
  oauthState: string | null;
};
const dbStore = new Map<number, Row>();

let currentTargetId = 0;

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
          const row = dbStore.get(currentTargetId);
          return Promise.resolve(row ? [row] : []);
        },
      }),
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const existing = dbStore.get(currentTargetId);
          if (existing) {
            dbStore.set(currentTargetId, { ...existing, ...values } as Row);
          }
          return Promise.resolve([]);
        },
      }),
    })),
  },
}));

vi.mock("../db/schema", () => ({
  mcpServers: { id: "id", oauthState: "oauth_state" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, value: number) => {
    currentTargetId = value;
    return { _col, value };
  },
}));

// `auth()` is not under test here — we want to verify our flow
// orchestration (validation, error surfacing, disconnect, listener
// CSRF check) without driving the SDK's PKCE state machine. Mock it
// out and assert call shape where relevant.
const authMock = vi.fn();
vi.mock("@ai-sdk/mcp", () => ({
  auth: authMock,
}));

// mcp_manager.dispose is called after a successful flow to force the
// cached client to rebuild. Mock to a no-op so we don't drag the
// whole manager into the test surface.
vi.mock("../ipc/utils/mcp_manager", () => ({
  mcpManager: { dispose: vi.fn() },
}));

const flowImport = await import("../ipc/utils/mcp_oauth_flow");
const { disconnectOAuth, runOAuthFlow } = flowImport;

function seedRow(row: Partial<Row> & { id: number }): void {
  dbStore.set(row.id, {
    id: row.id,
    name: row.name ?? `srv${row.id}`,
    transport: row.transport ?? "http",
    // Explicit `url: null` must be preserved (one of our tests seeds a
    // missing-URL row); only fall back to the default when the caller
    // omits the field entirely.
    url: "url" in row ? (row.url ?? null) : "https://example.com/mcp",
    oauthEnabled: row.oauthEnabled ?? true,
    oauthClientId: row.oauthClientId ?? null,
    oauthState: row.oauthState ?? null,
  });
}

describe("runOAuthFlow validation", () => {
  beforeEach(() => {
    dbStore.clear();
    authMock.mockReset();
  });

  it("returns an error result when the server id does not exist", async () => {
    const result = await runOAuthFlow({ serverId: 999 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("MCP server not found");
  });

  it("rejects stdio transport (OAuth only applies to http / sse)", async () => {
    // Stdio rows seeded here have a non-null URL so we exercise the
    // transport-rejection branch rather than the URL-missing one.
    seedRow({ id: 1, transport: "stdio", url: "ignored-for-stdio" });
    const result = await runOAuthFlow({ serverId: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("OAuth not supported");
  });

  it("rejects when URL is missing on an http server", async () => {
    seedRow({ id: 2, transport: "http", url: null });
    const result = await runOAuthFlow({ serverId: 2 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("OAuth requires HTTP or SSE");
  });
});

describe("runOAuthFlow happy path (auth resolves AUTHORIZED first call)", () => {
  beforeEach(() => {
    dbStore.clear();
    authMock.mockReset();
  });

  it("returns success without waiting for a redirect when auth() is AUTHORIZED", async () => {
    seedRow({ id: 3, transport: "http", url: "https://example.com/mcp" });
    // Pre-existing valid tokens: auth() refreshes silently and
    // returns 'AUTHORIZED' on the first call.
    authMock.mockResolvedValueOnce("AUTHORIZED");
    const result = await runOAuthFlow({
      serverId: 3,
      // Random high port to avoid colliding with the prod default
      // (53682) during parallel test runs.
      callbackPort: 53690,
    });
    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(authMock).toHaveBeenCalledTimes(1);
  });
});

describe("disconnectOAuth", () => {
  beforeEach(() => {
    dbStore.clear();
  });

  it("clears the encrypted oauth_state row when disconnecting", async () => {
    seedRow({
      id: 5,
      transport: "http",
      url: "https://example.com/mcp",
      oauthState: 'enc:{"tokens":{"access_token":"t"}}',
    });
    const result = await disconnectOAuth(5);
    expect(result.success).toBe(true);
    const row = dbStore.get(5);
    expect(row).toBeDefined();
    // After disconnect the row's oauthState should hold an encrypted
    // empty object, not the prior token blob.
    const stored = row!.oauthState ?? "";
    expect(stored.includes("access_token")).toBe(false);
  });

  it("returns success=false for an unknown server id", async () => {
    const result = await disconnectOAuth(404);
    expect(result.success).toBe(false);
  });
});

describe("OAuth loopback listener (state CSRF check)", () => {
  beforeEach(() => {
    dbStore.clear();
    authMock.mockReset();
  });

  it("accepts the OAuth callback over the IPv6 loopback address (`[::1]`)", async () => {
    // Regression test for the IPv4-only-bind footgun. Modern OS
    // resolvers often return `::1` first for `localhost`, so a
    // listener bound only to `127.0.0.1` would refuse the browser's
    // callback connection right after consent. This test sends the
    // callback to `[::1]` directly and asserts the listener receives
    // it, proving the IPv6 stack is bound.
    seedRow({ id: 10, transport: "http", url: "https://example.com/mcp" });
    authMock.mockResolvedValueOnce("REDIRECT");
    authMock.mockResolvedValueOnce("AUTHORIZED");

    const callbackPort = 53693;
    const flowPromise = runOAuthFlow({ serverId: 10, callbackPort });

    // Sniff out the `state` value the flow generated by waiting for
    // the listener to bind, then probing both stacks. We can't read
    // the state directly (it's flow-scoped), so we instead drive a
    // mismatching state first to read the rejection (which would also
    // close the listener), then -- nope. Simpler: use a probe that
    // matches the listener's path but lets us hit `[::1]` regardless
    // of how `localhost` would resolve. We use a Node `fetch` to
    // `http://[::1]:<port>/callback?...` directly with state=ok-state
    // EXTRACTED from a small intercept: the SDK's `auth()` is mocked
    // so we never know the real state. Approach: have the listener
    // resolve on ANY valid-shape callback by also passing state we
    // intercept. To avoid intercept gymnastics, we resort to brute
    // force: fire callbacks with synthetic state values until the
    // expected one lands. But state is cryptographically random.
    //
    // Cleanest path: hit the IPv6 endpoint with a known-wrong state
    // and assert it gets a 400 from THIS listener (not connection
    // refused). That proves IPv6 is reachable; CSRF correctness is
    // already covered by the next test.
    await new Promise((r) => setTimeout(r, 50));
    const probe = await fetch(
      `http://[::1]:${callbackPort}/callback?code=x&state=wrong`,
    );
    expect(probe.status).toBe(400);

    // Now the listener has settled (state mismatch closed it). The
    // flow promise resolves with the CSRF-mismatch error -- expected
    // path; the assertion that matters is that the IPv6 probe got a
    // real HTTP response and not ECONNREFUSED.
    const result = await flowPromise;
    expect(result.success).toBe(false);
  });

  it("rejects callbacks whose `state` does not match the expected value", async () => {
    seedRow({ id: 7, transport: "http", url: "https://example.com/mcp" });
    // Make auth() request a redirect (so the listener stays open).
    authMock.mockResolvedValueOnce("REDIRECT");

    // Race the runOAuthFlow against a delayed wrong-state callback.
    const callbackPort = 53691;
    const flowPromise = runOAuthFlow({ serverId: 7, callbackPort });

    // Give the listener a moment to bind, then send a forged
    // callback with a `state` value that cannot possibly match (the
    // expected `state` is a 22-char base64url string we don't know).
    await new Promise((r) => setTimeout(r, 50));
    const callbackResponse = await fetch(
      `http://127.0.0.1:${callbackPort}/callback?code=fake-code&state=not-the-real-state`,
    );
    expect(callbackResponse.status).toBe(400);

    const result = await flowPromise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/state.*did not match|CSRF/i);
  });
});
