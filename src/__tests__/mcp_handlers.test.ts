// @vitest-environment node
//
// Handler-level tests for the MCP IPC surface. The handlers register
// themselves via `ipcMain.handle(channel, fn)`. We mock electron so
// `ipcMain.handle` captures the (channel -> fn) pairs into a map; the
// tests then invoke captured handlers directly with a mock event +
// payload, exercising the real handler logic without an Electron
// process.

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- ipcMain capture ----------------------------------------------------
const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();

// --- DB mock (mcp_servers rows + the last update() payload) -------------
type Row = {
  id: number;
  name: string;
  transport: string;
  command: string | null;
  args: unknown;
  envJson: unknown;
  headersJson: unknown;
  url: string | null;
  enabled: boolean;
  oauthEnabled: boolean;
  oauthState: string | null;
  oauthClientId: string | null;
  oauthScope: string | null;
  createdAt: Date;
  updatedAt: Date;
};
const dbStore = new Map<number, Row>();
let lastUpdatePayload: Record<string, unknown> | null = null;
let lastUpdateTargetId = 0;

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, input: unknown) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
  },
  // `mcp_oauth_provider` is imported transitively (for
  // `oauthStateHasTokens`). Provide enough of the electron surface to
  // satisfy that module even though we never drive the OAuth flow
  // from these handler tests.
  shell: { openExternal: vi.fn() },
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
          // For the few selects the handlers under test perform.
          // The integration test below doesn't drive them, but
          // returning an empty array is safe enough not to crash
          // the other contracts registered at module load.
          return Promise.resolve([]);
        },
      }),
    })),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            lastUpdatePayload = values;
            const existing = dbStore.get(lastUpdateTargetId);
            const merged = { ...existing, ...values } as Row;
            if (existing) dbStore.set(existing.id, merged);
            return Promise.resolve(existing ? [merged] : []);
          },
        }),
      }),
    })),
    insert: vi.fn(() => ({
      values: () => ({
        returning: () => Promise.resolve([]),
      }),
    })),
    delete: vi.fn(() => ({
      where: () => Promise.resolve([]),
    })),
  },
}));

vi.mock("../db/schema", () => ({
  mcpServers: { id: "id", oauthState: "oauth_state" },
  mcpToolConsents: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, value: number) => {
    lastUpdateTargetId = value;
    return { _col, value };
  },
  and: (..._args: unknown[]) => ({}),
}));

// The handlers under test reach into the manager (for dispose) and
// the OAuth flow (for start/disconnect). Keep both as no-op fakes --
// we only assert on the DB shape the handlers produce.
const getClientMock = vi.fn();
const disposeMock = vi.fn();
vi.mock("../ipc/utils/mcp_manager", () => ({
  mcpManager: {
    getClient: getClientMock,
    dispose: disposeMock,
  },
}));

vi.mock("../ipc/utils/mcp_oauth_flow", () => ({
  runOAuthFlow: vi.fn(),
  disconnectOAuth: vi.fn(),
}));

vi.mock("../ipc/utils/mcp_consent", () => ({
  resolveConsent: vi.fn(),
  getStoredConsent: vi.fn(),
}));

// Trigger module load AFTER mocks resolve so the handlers are
// captured against our fake `ipcMain.handle`.
const handlersModule = await import("../ipc/handlers/mcp_handlers");
handlersModule.registerMcpHandlers();

function invoke<T>(channel: string, input: unknown): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for channel ${channel}`);
  return Promise.resolve(fn({}, input)) as Promise<T>;
}

function seedRow(row: Partial<Row> & { id: number }): Row {
  const full: Row = {
    id: row.id,
    name: row.name ?? `srv${row.id}`,
    transport: row.transport ?? "http",
    command: row.command ?? null,
    args: row.args ?? null,
    envJson: row.envJson ?? null,
    headersJson: row.headersJson ?? null,
    url: row.url ?? "https://example.com/mcp",
    enabled: row.enabled ?? true,
    oauthEnabled: row.oauthEnabled ?? true,
    oauthState: row.oauthState ?? null,
    oauthClientId: row.oauthClientId ?? null,
    oauthScope: row.oauthScope ?? null,
    createdAt: row.createdAt ?? new Date(),
    updatedAt: row.updatedAt ?? new Date(),
  };
  dbStore.set(full.id, full);
  return full;
}

describe("mcp updateServer handler", () => {
  beforeEach(() => {
    dbStore.clear();
    lastUpdatePayload = null;
    vi.clearAllMocks();
  });

  it("clears oauthState when oauthClientId is changed", async () => {
    // Stored row already has tokens (i.e. user is currently
    // connected to the server with the old client_id). Editing the
    // client_id field must wipe the cached OAuth state so the next
    // flow re-seeds clientInformation from the new value -- without
    // this, the old client_id stays cached forever and edits to the
    // field appear to do nothing.
    seedRow({
      id: 42,
      oauthClientId: "old-client",
      oauthState: "enc:something-tokenlike",
    });

    await invoke("mcp:update-server", {
      id: 42,
      oauthClientId: "new-client",
    });

    expect(lastUpdatePayload).not.toBeNull();
    expect(lastUpdatePayload!.oauthClientId).toBe("new-client");
    // The critical assertion: oauthState is set to null in the same
    // update payload, NOT left untouched.
    expect(lastUpdatePayload!.oauthState).toBeNull();
    expect("oauthState" in lastUpdatePayload!).toBe(true);
  });

  it("does NOT touch oauthState when oauthClientId is omitted from the update", async () => {
    // Regression guard: editing only `name` (or any non-OAuth field)
    // must leave the stored tokens alone. Without this, every
    // unrelated edit would silently disconnect the user.
    seedRow({
      id: 43,
      oauthClientId: "existing",
      oauthState: "enc:tokens",
    });

    await invoke("mcp:update-server", {
      id: 43,
      name: "renamed",
    });

    expect(lastUpdatePayload).not.toBeNull();
    expect("oauthState" in lastUpdatePayload!).toBe(false);
    expect("oauthClientId" in lastUpdatePayload!).toBe(false);
  });

  it("disposes the cached MCP client so the next use rebuilds with the new config", async () => {
    seedRow({ id: 44 });
    await invoke("mcp:update-server", { id: 44, name: "renamed" });
    expect(disposeMock).toHaveBeenCalledWith(44);
  });
});

describe("mcp listTools handler", () => {
  beforeEach(() => {
    dbStore.clear();
    vi.clearAllMocks();
  });

  it("returns an empty list (not a crash) when getClient throws", async () => {
    // This is the ambient-failure shape the user sees while OAuth is
    // disconnected: `mcp_manager.getClient` throws because the
    // provider refuses to open a browser without an explicit Connect
    // click. The IPC handler must swallow the throw and surface
    // [] so the renderer renders "no tools" instead of crashing.
    getClientMock.mockRejectedValueOnce(
      new Error(
        "OAuth not currently allowed (interactive consent required; click Connect on the server row).",
      ),
    );

    const result = await invoke<unknown[]>("mcp:list-tools", 1);
    expect(result).toEqual([]);
  });

  it("returns an empty list when the underlying client.tools() throws", async () => {
    // Slightly different failure path -- getClient resolves but the
    // returned client's `tools()` blows up (e.g. transport 401 after
    // tokens expired AND refresh failed). Same UI contract: no
    // crash, empty list.
    const failingTools = vi
      .fn()
      .mockRejectedValueOnce(new Error("401 Unauthorized"));
    getClientMock.mockResolvedValueOnce({ tools: failingTools });

    const result = await invoke<unknown[]>("mcp:list-tools", 2);
    expect(result).toEqual([]);
    expect(failingTools).toHaveBeenCalled();
  });
});
