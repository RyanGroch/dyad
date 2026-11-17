import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fetch as undiciFetch } from "undici";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apps } from "@/db/schema";
import { DyadErrorKind } from "@/errors/dyad_error";
import { registerAppHandlers } from "@/ipc/handlers/app_handlers";
import { registerSupabaseHandlers } from "@/ipc/handlers/supabase_handlers";
import {
  setupHandlerTestHarness,
  type HandlerTestHarness,
} from "@/testing/handler_test_harness";
import {
  startFakeSupabaseSelfHosted,
  type FakeSupabaseSelfHosted,
} from "@/testing/fake_supabase_self_hosted_server";

const mocks = vi.hoisted(() => ({ readSettings: vi.fn() }));

vi.mock("@/main/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/main/settings")>();
  return { ...actual, readSettings: mocks.readSettings };
});

interface AddResult {
  instance: { id: string; name: string; url: string };
  warnings: string[];
}

describe("self-hosted Supabase instances (integration)", () => {
  let harness: HandlerTestHarness | undefined;
  let fake: FakeSupabaseSelfHosted | undefined;
  let appDirectory: string;

  // happy-dom's fetch strips cross-origin Authorization headers, which the
  // legacy service_role key needs on the admin API.
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
    registerSupabaseHandlers();
    registerAppHandlers();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dyad-self-hosted-"));
    fs.writeFileSync(path.join(appDirectory, "index.ts"), "// app");
    mocks.readSettings.mockReturnValue({ enableSupabaseSelfHosted: true });
    fake = await startFakeSupabaseSelfHosted("coolify");
    harness = setupHandlerTestHarness();
  });

  afterEach(async () => {
    harness?.dispose();
    await fake?.close();
    fs.rmSync(appDirectory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const addInstance = () =>
    harness!.invokeHandler<AddResult>("supabase:add-self-hosted-instance", {
      name: "Coolify box",
      url: `${fake!.url}/`,
      studioUrl: null,
      anonKey: fake!.anonKey,
      serviceKey: fake!.serviceKey,
    });

  it("checks, saves and serves an instance to a linked app", async () => {
    const { instance, warnings } = await addInstance();

    expect(instance).toMatchObject({ name: "Coolify box", url: fake!.url });
    expect(warnings).toEqual([
      expect.stringContaining("http://supabase-kong:8000"),
    ]);
    await expect(
      harness!.invokeHandler("supabase:list-self-hosted-instances"),
    ).resolves.toEqual([
      { id: instance.id, name: "Coolify box", url: fake!.url, studioUrl: null },
    ]);

    const app = harness!.db
      .insert(apps)
      .values({
        name: "Shop",
        path: appDirectory,
        supabaseProjectId: instance.id,
      })
      .returning()
      .get();

    await expect(
      harness!.invokeHandler("get-app", app.id),
    ).resolves.toMatchObject({
      supabaseProjectName: "Coolify box",
      supabaseSelfHosted: {
        id: instance.id,
        name: "Coolify box",
        url: fake!.url,
        studioUrl: null,
      },
    });
    await expect(
      harness!.invokeHandler("supabase:remove-self-hosted-instance", {
        id: instance.id,
      }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Conflict });
  });

  it("refuses to add an instance while the experiment is off", async () => {
    mocks.readSettings.mockReturnValue({});

    await expect(addInstance()).rejects.toMatchObject({
      kind: DyadErrorKind.Precondition,
    });
    expect(fake!.requests).toEqual([]);
  });

  it("does not save an instance that fails its checks", async () => {
    fake!.anonCanQuery = true;

    await expect(addInstance()).rejects.toMatchObject({
      kind: DyadErrorKind.Validation,
    });
    await expect(
      harness!.invokeHandler("supabase:list-self-hosted-instances"),
    ).resolves.toEqual([]);
  });
});
