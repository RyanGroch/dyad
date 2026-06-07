import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getUserDataPath } from "@/paths/paths";
import {
  buildMainException,
  recordMainException,
  readMainExceptionRecord,
  clearMainExceptionRecord,
} from "@/main/settings";

vi.mock("@/paths/paths", () => ({
  getUserDataPath: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => []),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("@/ipc/shared/remote_desktop_config", () => ({
  getRemoteDesktopConfig: vi.fn(),
}));

const mockGetUserDataPath = vi.mocked(getUserDataPath);

describe("buildMainException", () => {
  it("carries the fields and defaults the timestamp", () => {
    const exc = buildMainException({
      name: "TypeError",
      message: "x is not a function",
      stack: "TypeError: x\n  at foo",
      origin: "uncaughtException",
    });
    expect(exc).toMatchObject({
      name: "TypeError",
      message: "x is not a function",
      origin: "uncaughtException",
    });
    expect(typeof exc.timestamp).toBe("number");
  });

  it("truncates oversized message and stack", () => {
    const exc = buildMainException({
      name: "Error",
      message: "x".repeat(5_000),
      stack: "y".repeat(10_000),
      origin: "unhandledRejection",
    });
    expect(exc.message!.length).toBeLessThan(1_100);
    expect(exc.message!.endsWith("…[truncated]")).toBe(true);
    expect(exc.stack!.length).toBeLessThan(4_100);
    expect(exc.stack!.endsWith("…[truncated]")).toBe(true);
  });
});

describe("main exception record (stash)", () => {
  let tmpDir: string;
  const recordPath = () => path.join(tmpDir, "main-exception.json");

  const record = (name: string) =>
    recordMainException(
      buildMainException({ name, origin: "uncaughtException" }),
    );

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "main-exc-test-"));
    mockGetUserDataPath.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("round-trips a stashed exception", () => {
    record("TypeError");
    const read = readMainExceptionRecord();
    expect(read).not.toBeNull();
    expect(read!.exceptions).toHaveLength(1);
    expect(read!.exceptions[0].name).toBe("TypeError");
  });

  it("keeps the last N exceptions", () => {
    for (let i = 0; i < 7; i++) {
      record(`E${i}`);
    }
    expect(readMainExceptionRecord()!.exceptions.map((e) => e.name)).toEqual([
      "E2",
      "E3",
      "E4",
      "E5",
      "E6",
    ]);
  });

  it("writes the file as readable (multi-line) JSON", () => {
    record("Error");
    const contents = fs.readFileSync(recordPath(), "utf-8");
    expect(contents).toContain("\n");
    expect(contents.split("\n").length).toBeGreaterThan(3);
  });

  it("clear removes the record", () => {
    record("Error");
    clearMainExceptionRecord();
    expect(readMainExceptionRecord()).toBeNull();
  });

  it("returns null when no record file exists", () => {
    expect(readMainExceptionRecord()).toBeNull();
  });

  it("discards corrupt JSON instead of throwing", () => {
    fs.writeFileSync(recordPath(), "{ not json");
    expect(readMainExceptionRecord()).toBeNull();
  });

  it("discards a record whose exceptions are all malformed", () => {
    fs.writeFileSync(
      recordPath(),
      JSON.stringify({ exceptions: [{ nope: true }] }),
    );
    expect(readMainExceptionRecord()).toBeNull();
  });
});
