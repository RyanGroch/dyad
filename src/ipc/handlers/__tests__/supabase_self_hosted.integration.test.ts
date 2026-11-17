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
import {
  startFakeEdgeRuntimeSsh,
  type FakeEdgeRuntimeSsh,
} from "@/testing/fake_supabase_edge_runtime_ssh";
import { generateSshKeyPair } from "@/testing/fake_ssh_server";
import { closeSupabaseSelfHostedSessions } from "@/supabase_admin/supabase_self_hosted_functions";

const mocks = vi.hoisted(() => ({ readSettings: vi.fn() }));

vi.mock("@/main/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/main/settings")>();
  return { ...actual, readSettings: mocks.readSettings };
});

interface AddResult {
  instance: {
    id: string;
    name: string;
    url: string;
    ssh: { host: string; port: number; username: string } | null;
  };
  warnings: string[];
}

describe("self-hosted Supabase instances (integration)", () => {
  let harness: HandlerTestHarness | undefined;
  let fake: FakeSupabaseSelfHosted | undefined;
  let edgeSsh: FakeEdgeRuntimeSsh | undefined;
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
    closeSupabaseSelfHostedSessions();
    await edgeSsh?.close();
    edgeSsh = undefined;
    fs.rmSync(appDirectory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const addInstance = (
    ssh: {
      host: string;
      port: number;
      username: string;
      privateKey: string;
    } | null = null,
  ) =>
    harness!.invokeHandler<AddResult>("supabase:add-self-hosted-instance", {
      name: "Coolify box",
      url: `${fake!.url}/`,
      studioUrl: null,
      anonKey: fake!.anonKey,
      serviceKey: fake!.serviceKey,
      ssh,
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
      {
        id: instance.id,
        name: "Coolify box",
        url: fake!.url,
        studioUrl: null,
        ssh: null,
      },
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

  it("finds the functions container when added with SSH", async () => {
    edgeSsh = await startFakeEdgeRuntimeSsh([
      {
        name: "supabase-edge-functions-x1",
        image: "supabase/edge-runtime:v1.71.2",
      },
    ]);
    fake!.serveFunction = (name) =>
      edgeSsh!.files
        .get("supabase-edge-functions-x1")
        ?.get(`${name}/index.ts`)
        ?.match(/new Response\("(\w+)"\)/)?.[1];

    const { instance } = await addInstance({
      host: "127.0.0.1",
      port: edgeSsh.port,
      username: "deployer",
      // Pasted keys often lose their final newline.
      privateKey: generateSshKeyPair().private.trim(),
    });

    expect(instance.ssh).toEqual({
      host: "127.0.0.1",
      port: edgeSsh.port,
      username: "deployer",
    });
    // The test function was deployed through the gateway's URL and removed.
    expect(
      fake!.requests.some((request) =>
        request.path.startsWith("/functions/v1/dyad-check-"),
      ),
    ).toBe(true);
    expect(edgeSsh.files.get("supabase-edge-functions-x1")?.size).toBe(0);
  });

  it("does not save an instance whose SSH check fails", async () => {
    edgeSsh = await startFakeEdgeRuntimeSsh();
    edgeSsh.dockerDenied = true;

    await expect(
      addInstance({
        host: "127.0.0.1",
        port: edgeSsh.port,
        username: "deployer",
        privateKey: generateSshKeyPair().private,
      }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Precondition });
    await expect(
      harness!.invokeHandler("supabase:list-self-hosted-instances"),
    ).resolves.toEqual([]);
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
