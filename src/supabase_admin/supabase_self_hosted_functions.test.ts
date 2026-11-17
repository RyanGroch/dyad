// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DyadErrorKind } from "@/errors/dyad_error";
import { generateSshKeyPair } from "@/testing/fake_ssh_server";
import {
  readTarArchive,
  startFakeEdgeRuntimeSsh,
  type FakeEdgeRuntimeSsh,
} from "@/testing/fake_supabase_edge_runtime_ssh";
import {
  startFakeSupabaseSelfHosted,
  type FakeSupabaseSelfHosted,
} from "@/testing/fake_supabase_self_hosted_server";
import {
  checkSupabaseSelfHostedSsh,
  closeSupabaseSelfHostedSessions,
  createTarArchive,
  deleteSupabaseSelfHostedFunction,
  deployCommand,
  deploySupabaseSelfHostedFunction,
  parseEdgeRuntimeLogs,
  readSupabaseSelfHostedFunctionLogs,
} from "./supabase_self_hosted_functions";
import recordedLogs from "./__fixtures__/supabase_self_hosted/upstream/edge_runtime_logs.txt?raw";

const encode = (text: string) => new TextEncoder().encode(text);
const key = generateSshKeyPair().private;

let ssh: FakeEdgeRuntimeSsh | undefined;
let http: FakeSupabaseSelfHosted | undefined;

afterEach(async () => {
  closeSupabaseSelfHostedSessions();
  await ssh?.close();
  await http?.close();
  ssh = undefined;
  http = undefined;
});

function instanceFor(server: FakeEdgeRuntimeSsh, container?: string) {
  return {
    id: `instance-${server.port}`,
    ssh: {
      host: "127.0.0.1",
      port: server.port,
      username: "deployer",
      privateKey: key,
      hostKeyFingerprint: server.hostKeyFingerprint,
      functionsContainer: container ?? server.containers[0].name,
    },
  };
}

describe("createTarArchive", () => {
  it("writes files tar can read back, including paths over 100 bytes", () => {
    const longPath = `hello/${"nested/".repeat(16)}deep.ts`;
    const archive = createTarArchive([
      { relativePath: "hello/index.ts", content: encode("export {};\n") },
      { relativePath: longPath, content: encode("x".repeat(700)) },
    ]);

    expect(archive.length % 512).toBe(0);
    expect(readTarArchive(archive)).toEqual(
      new Map([
        ["hello/index.ts", "export {};\n"],
        [longPath, "x".repeat(700)],
      ]),
    );
  });
});

// The fake server below unpacks archives itself, so the shell script that
// runs inside the container is exercised here with a real sh and tar.
describe.skipIf(process.platform === "win32")("the deploy script", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dyad-functions-"));
    for (const [file, text] of [
      ["hello/old.ts", "stale"],
      ["_shared/other-app.ts", "kept"],
      ["main/index.ts", "router"],
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const runScript = (input: Uint8Array) => {
    const script = /sh -c '([\s\S]*)'$/
      .exec(deployCommand("container", "hello"))![1]
      .replace("/home/deno/functions", root);
    return execFileSync("sh", ["-c", script], {
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
  const tree = () =>
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path
          .relative(root, path.join(entry.parentPath, entry.name))
          .split(path.sep)
          .join("/"),
      )
      .sort();

  it("replaces the function, merges _shared and leaves nothing behind", () => {
    runScript(
      createTarArchive([
        { relativePath: "hello/index.ts", content: encode("new") },
        { relativePath: "_shared/cors.ts", content: encode("cors") },
      ]),
    );

    expect(tree()).toEqual([
      "_shared/cors.ts",
      "_shared/other-app.ts",
      "hello/index.ts",
      "main/index.ts",
    ]);
  });

  it("keeps the deployed function when the upload is broken", () => {
    expect(() => runScript(encode("not a tar archive"))).toThrow();

    expect(tree()).toEqual([
      "_shared/other-app.ts",
      "hello/old.ts",
      "main/index.ts",
    ]);
  });
});

describe("parseEdgeRuntimeLogs", () => {
  it("turns recorded upstream output into one entry per console call", () => {
    const entries = parseEdgeRuntimeLogs(recordedLogs);

    expect(entries.map(({ level, message }) => [level, message])).toEqual([
      [
        "info",
        '[hello-logs] request received { mode: "ok", nested: { ok: true } }',
      ],
      ["warn", "[hello-logs] slow path"],
      ["info", "[hello-logs] two\nlines"],
      ["error", "unprefixed error line"],
      [
        "info",
        '[hello-logs] request received { mode: "throw", nested: { ok: true } }',
      ],
      ["warn", "[hello-logs] slow path"],
      ["info", "[hello-logs] two\nlines"],
      [
        "error",
        expect.stringMatching(
          /^\[hello-logs\] Error: handler failed\n    at Object\.handler/,
        ),
      ],
    ]);
    expect(entries[0].timestamp).toBe(Date.parse("2026-11-17T17:30:44.785Z"));
  });

  it("drops the runtime's own startup line", () => {
    // Recorded: Deno.serve prints this whenever a function's worker starts.
    const entries = parseEdgeRuntimeLogs(
      [
        "2026-11-17T18:45:55.804643107Z [Info] Listening on http://localhost:9999/",
        "2026-11-17T18:45:55.804650000Z ",
        "2026-11-17T18:45:55.928121582Z [Info] [clear-completed] Listening on http://localhost:9999/",
        "2026-11-17T18:45:55.928130000Z ",
      ].join("\n"),
    );

    expect(entries.map((entry) => entry.message)).toEqual([
      "[clear-completed] Listening on http://localhost:9999/",
    ]);
  });
});

describe("deploying over SSH", () => {
  beforeEach(async () => {
    ssh = await startFakeEdgeRuntimeSsh();
  });

  it("replaces the function's directory and merges shared files", async () => {
    const container = ssh!.containers[0].name;
    ssh!.files.set(
      container,
      new Map([
        ["hello/old.ts", "stale"],
        ["_shared/other-app.ts", "kept"],
        ["main/index.ts", "router"],
      ]),
    );

    await deploySupabaseSelfHostedFunction({
      instance: instanceFor(ssh!),
      functionName: "hello",
      files: [
        { relativePath: "hello/index.ts", content: encode("new") },
        { relativePath: "_shared/cors.ts", content: encode("cors") },
      ],
    });

    expect(ssh!.files.get(container)).toEqual(
      new Map([
        ["_shared/other-app.ts", "kept"],
        ["main/index.ts", "router"],
        ["hello/index.ts", "new"],
        ["_shared/cors.ts", "cors"],
      ]),
    );
  });

  it("never touches the router function", async () => {
    await expect(
      deploySupabaseSelfHostedFunction({
        instance: instanceFor(ssh!),
        functionName: "main",
        files: [{ relativePath: "main/index.ts", content: encode("x") }],
      }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Validation });
    await expect(
      deleteSupabaseSelfHostedFunction({
        instance: instanceFor(ssh!),
        functionName: "main",
      }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Validation });
    expect(ssh!.commands).toEqual([]);
  });

  it("refuses files outside the function and shared directories", async () => {
    await expect(
      deploySupabaseSelfHostedFunction({
        instance: instanceFor(ssh!),
        functionName: "hello",
        files: [
          { relativePath: "hello/index.ts", content: encode("x") },
          { relativePath: "hello/../main/index.ts", content: encode("x") },
        ],
      }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Validation });
    expect(ssh!.commands).toEqual([]);
  });

  it("deletes only the named function", async () => {
    const container = ssh!.containers[0].name;
    ssh!.files.set(
      container,
      new Map([
        ["hello/index.ts", "a"],
        ["hello-two/index.ts", "b"],
      ]),
    );

    await deleteSupabaseSelfHostedFunction({
      instance: instanceFor(ssh!),
      functionName: "hello",
    });

    expect([...ssh!.files.get(container)!.keys()]).toEqual([
      "hello-two/index.ts",
    ]);
  });

  it("reads logs since a time and reuses one connection", async () => {
    ssh!.logs = recordedLogs;
    const instance = instanceFor(ssh!);

    const logs = await readSupabaseSelfHostedFunctionLogs({
      instance,
      sinceMs: 1_794_936_000_123,
    });
    await readSupabaseSelfHostedFunctionLogs({ instance, sinceMs: 0 });

    expect(logs).toHaveLength(8);
    expect(ssh!.commands[0]).toContain("--since 1794936000.123 ");
    expect(ssh!.connections).toBe(1);
  });

  it("reconnects once when the server closed a pooled connection", async () => {
    const instance = instanceFor(ssh!);
    await readSupabaseSelfHostedFunctionLogs({ instance, sinceMs: 0 });
    ssh!.dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(
      readSupabaseSelfHostedFunctionLogs({ instance, sinceMs: 0 }),
    ).resolves.toEqual([]);
    expect(ssh!.connections).toBe(2);
  });

  it("refuses a server whose host key changed", async () => {
    const instance = instanceFor(ssh!);
    instance.ssh.hostKeyFingerprint = "SHA256:someone-else";

    await expect(
      readSupabaseSelfHostedFunctionLogs({ instance, sinceMs: 0 }),
    ).rejects.toThrow("host key changed");
    expect(ssh!.commands).toEqual([]);
  });

  it("explains a user who can't run docker", async () => {
    ssh!.dockerDenied = true;

    await expect(
      readSupabaseSelfHostedFunctionLogs({
        instance: instanceFor(ssh!),
        sinceMs: 0,
      }),
    ).rejects.toMatchObject({
      kind: DyadErrorKind.Precondition,
      message: expect.stringContaining("docker group"),
    });
  });
});

describe("checkSupabaseSelfHostedSsh", () => {
  async function start(containers: { name: string; image: string }[]) {
    ssh = await startFakeEdgeRuntimeSsh(containers);
    http = await startFakeSupabaseSelfHosted("coolify");
    return { ssh, http };
  }

  const check = () =>
    checkSupabaseSelfHostedSsh({
      url: http!.url,
      anonKey: http!.anonKey,
      ssh: {
        host: "127.0.0.1",
        port: ssh!.port,
        username: "deployer",
        privateKey: key,
      },
    });

  it("finds the container that serves the instance's URL and cleans up", async () => {
    await start([
      { name: "supabase-db-a1", image: "supabase/postgres:15.8.1.085" },
      {
        name: "supabase-edge-functions-a1",
        image: "supabase/edge-runtime:v1.71.2",
      },
      {
        name: "supabase-edge-functions-b2",
        image: "supabase/edge-runtime:v1.71.2",
      },
    ]);
    // Only the second instance's runtime is behind this gateway.
    http!.serveFunction = (name) =>
      ssh!.files
        .get("supabase-edge-functions-b2")
        ?.get(`${name}/index.ts`)
        ?.match(/new Response\("(\w+)"\)/)?.[1];

    await expect(check()).resolves.toEqual({
      hostKeyFingerprint: ssh!.hostKeyFingerprint,
      functionsContainer: "supabase-edge-functions-b2",
    });
    for (const dir of ssh!.files.values()) expect(dir.size).toBe(0);
  });

  it("refuses when no deployed test function is served", async () => {
    await start([
      {
        name: "supabase-edge-functions",
        image: "supabase/edge-runtime:v1.77.9",
      },
    ]);

    await expect(check()).rejects.toMatchObject({
      kind: DyadErrorKind.Precondition,
      message: expect.stringContaining("wasn't served"),
    });
    expect(ssh!.files.get("supabase-edge-functions")?.size).toBe(0);
  });

  it("refuses a server without an edge runtime container", async () => {
    await start([{ name: "web", image: "nginx:1.27" }]);

    await expect(check()).rejects.toThrow(
      "no Supabase edge functions container",
    );
  });
});
