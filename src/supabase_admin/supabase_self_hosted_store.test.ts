// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryTestDb, type TestDb } from "@/testing/test_db";
import {
  startFakeSupabaseSelfHosted,
  type FakeSupabaseSelfHosted,
} from "@/testing/fake_supabase_self_hosted_server";
import {
  apps,
  supabaseSelfHostedInstances,
  testUserCleanup,
} from "@/db/schema";
import { DyadErrorKind } from "@/errors/dyad_error";
import {
  deleteSupabaseSelfHostedInstance,
  getSupabaseProjectUrl,
  getSupabaseSelfHostedInstance,
  hasSupabaseCredentialsForApp,
  insertSupabaseSelfHostedInstance,
  isSupabaseSelfHostedProject,
  listSupabaseSelfHostedInstances,
} from "./supabase_self_hosted_store";
import {
  deploySupabaseFunction,
  executeSupabaseSql,
  getProjectApiKeys,
  getSupabaseProjectName,
  listSupabaseSecretNames,
} from "./supabase_management_client";
import { deploySupabaseFunctions } from "./supabase_utils";
import { isSupabaseFunctionSyncSkipped } from "./supabase_function_sync_skip";

const holder = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    { get: (_target, property) => (holder.db as any)[property] },
  ),
}));

// Reversible stand-in for safeStorage, which needs a running Electron app.
vi.mock("@/ipc/utils/secret_storage", () => ({
  encryptToString: (plaintext: string) => `enc:${plaintext}`,
  decryptFromString: (stored: string) => stored.replace(/^enc:/, ""),
}));

vi.mock("@/main/settings", () => ({
  readSettings: vi.fn(() => ({})),
  writeSettings: vi.fn(),
}));

let db: TestDb;
let fake: FakeSupabaseSelfHosted | undefined;

beforeEach(() => {
  db = createInMemoryTestDb();
  holder.db = db;
});

afterEach(async () => {
  db.$client.close();
  await fake?.close();
  fake = undefined;
});

async function addInstance(overrides: { url?: string } = {}) {
  return insertSupabaseSelfHostedInstance({
    name: "Home lab",
    url: overrides.url ?? "https://supabase.example.com",
    studioUrl: null,
    anonKey: "sb_publishable_anon",
    serviceKey: "sb_secret_service",
  });
}

describe("self-hosted instance store", () => {
  it("stores keys encrypted and never lists them", async () => {
    const instance = await addInstance();

    const row = db.select().from(supabaseSelfHostedInstances).get()!;
    expect(row.serviceKeyEncrypted).toBe("enc:sb_secret_service");
    expect(await listSupabaseSelfHostedInstances()).toEqual([
      {
        id: instance.id,
        name: "Home lab",
        url: "https://supabase.example.com",
        studioUrl: null,
      },
    ]);
    expect(getSupabaseSelfHostedInstance(instance.id)).toMatchObject({
      anonKey: "sb_publishable_anon",
      serviceKey: "sb_secret_service",
    });
  });

  it("tells instance ids apart from Cloud project refs", async () => {
    const instance = await addInstance();

    expect(isSupabaseSelfHostedProject(instance.id)).toBe(true);
    expect(isSupabaseSelfHostedProject("abcdefghijklmnopqrst")).toBe(false);
    expect(getSupabaseProjectUrl(instance.id)).toBe(
      "https://supabase.example.com",
    );
    expect(getSupabaseProjectUrl("abcdefghijklmnopqrst")).toBe(
      "https://abcdefghijklmnopqrst.supabase.co",
    );
  });

  it("treats a self-hosted app as connected without an organization", async () => {
    const instance = await addInstance();

    expect(
      hasSupabaseCredentialsForApp(
        {},
        { supabaseProjectId: instance.id, supabaseOrganizationSlug: null },
      ),
    ).toBe(true);
    expect(
      hasSupabaseCredentialsForApp(
        {},
        {
          supabaseProjectId: "abcdefghijklmnopqrst",
          supabaseOrganizationSlug: null,
        },
      ),
    ).toBe(false);
  });

  it("refuses to remove an instance an app still uses", async () => {
    const instance = await addInstance();
    db.insert(apps)
      .values({ name: "Shop", path: "shop", supabaseProjectId: instance.id })
      .run();

    await expect(
      deleteSupabaseSelfHostedInstance(instance.id),
    ).rejects.toMatchObject({
      kind: DyadErrorKind.Conflict,
      message: expect.stringContaining("Shop"),
    });
    expect(isSupabaseSelfHostedProject(instance.id)).toBe(true);
  });

  it("drops only its own pending test-user cleanup when removed", async () => {
    const instance = await addInstance();
    db.insert(testUserCleanup)
      .values([
        {
          userId: "u1",
          appId: 1,
          ownerId: "o1",
          projectId: instance.id,
          organizationSlug: "",
        },
        {
          userId: "u2",
          appId: 2,
          ownerId: "o2",
          projectId: "abcdefghijklmnopqrst",
          organizationSlug: "org",
        },
      ])
      .run();

    await deleteSupabaseSelfHostedInstance(instance.id);

    expect(isSupabaseSelfHostedProject(instance.id)).toBe(false);
    expect(
      db.select({ userId: testUserCleanup.userId }).from(testUserCleanup).all(),
    ).toEqual([{ userId: "u2" }]);
  });

  it("reports an instance that is already gone", async () => {
    await expect(
      deleteSupabaseSelfHostedInstance("missing"),
    ).rejects.toMatchObject({ kind: DyadErrorKind.NotFound });
  });
});

describe("Supabase operations on a self-hosted project", () => {
  it("runs SQL through the instance instead of the Management API", async () => {
    fake = await startFakeSupabaseSelfHosted("upstream");
    fake.onQuery = () => ({ status: 200, body: [{ answer: 42 }] });
    const instance = await insertSupabaseSelfHostedInstance({
      name: "Fake",
      url: fake.url,
      studioUrl: null,
      anonKey: fake.anonKey,
      serviceKey: fake.serviceKey,
    });

    await expect(
      executeSupabaseSql({
        supabaseProjectId: instance.id,
        organizationSlug: null,
        query: "select 42 as answer",
      }),
    ).resolves.toBe(JSON.stringify([{ answer: 42 }]));
    expect(fake.requests.map((request) => request.path)).toEqual(["/pg/query"]);
  });

  it("serves the configured keys in the Management API's shape", async () => {
    const instance = await addInstance();

    await expect(
      getProjectApiKeys({ projectId: instance.id, organizationSlug: null }),
    ).resolves.toEqual([
      { name: "anon", type: "publishable", api_key: "sb_publishable_anon" },
    ]);
    await expect(
      getProjectApiKeys({
        projectId: instance.id,
        organizationSlug: null,
        reveal: true,
      }),
    ).resolves.toContainEqual({
      name: "service_role",
      type: "secret",
      api_key: "sb_secret_service",
    });
  });

  it("names the project and reports no secrets", async () => {
    const instance = await addInstance();

    await expect(getSupabaseProjectName(instance.id)).resolves.toBe("Home lab");
    await expect(
      listSupabaseSecretNames({
        supabaseProjectId: instance.id,
        organizationSlug: null,
      }),
    ).resolves.toEqual([]);
  });

  it("skips edge function deploys rather than failing them", async () => {
    const instance = await addInstance();

    const single = await deploySupabaseFunction({
      supabaseProjectId: instance.id,
      functionName: "hello",
      appPath: "/tmp/does-not-matter",
      organizationSlug: null,
    }).catch((error: unknown) => error);
    const all = await deploySupabaseFunctions({
      appPath: "/tmp/does-not-matter",
      supabaseProjectId: instance.id,
      supabaseOrganizationSlug: null,
      skipPruneEdgeFunctions: false,
    }).catch((error: unknown) => error);

    expect(isSupabaseFunctionSyncSkipped(single)).toBe(true);
    expect(isSupabaseFunctionSyncSkipped(all)).toBe(true);
  });
});
