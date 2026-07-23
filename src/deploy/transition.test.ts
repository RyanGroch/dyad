import { describe, expect, it } from "vitest";
import type { DeployState } from "./state";
import { transition } from "./transition";

const T0 = 1_000;
const T1 = 2_000;

function running(stage: "build" | "upload" = "build"): DeployState {
  return { status: "running", stage, startedAt: T0 };
}

describe("deploy transition", () => {
  it("starts from idle into preflight and runs the check", () => {
    const result = transition({ status: "idle" }, { type: "START", at: T0 });
    expect(result.state).toEqual({ status: "preflight", startedAt: T0 });
    expect(result.commands).toEqual([{ type: "RunPreflight" }]);
  });

  it("allows restarting from any terminal state", () => {
    for (const state of [
      { status: "succeeded", startedAt: T0, finishedAt: T1 },
      {
        status: "failed",
        stage: null,
        error: "x",
        startedAt: T0,
        finishedAt: T1,
      },
      { status: "cancelled", startedAt: T0, finishedAt: T1 },
    ] satisfies DeployState[]) {
      const result = transition(state, { type: "START", at: T1 });
      expect(result.state.status).toBe("preflight");
    }
  });

  it("ignores START while a deploy is active", () => {
    const result = transition(running(), { type: "START", at: T1 });
    expect(result.ignoredReason).toBe("deploy-in-flight");
    expect(result.state).toBe(
      running().status === "running" ? result.state : running(),
    );
  });

  it("spawns the deploy script after preflight passes", () => {
    const result = transition(
      { status: "preflight", startedAt: T0 },
      { type: "PREFLIGHT_PASSED" },
    );
    expect(result.state).toEqual({
      status: "running",
      stage: "build",
      startedAt: T0,
    });
    expect(result.commands).toEqual([{ type: "SpawnDeploy" }]);
  });

  it("fails with the preflight stage when the connection check fails", () => {
    const result = transition(
      { status: "preflight", startedAt: T0 },
      { type: "PREFLIGHT_FAILED", error: "auth rejected", at: T1 },
    );
    expect(result.state).toEqual({
      status: "failed",
      stage: "preflight",
      error: "auth rejected",
      startedAt: T0,
      finishedAt: T1,
    });
  });

  it("advances stages on marker events", () => {
    const result = transition(running("build"), {
      type: "STAGE_MARKER",
      stage: "upload",
    });
    expect(result.state).toEqual(running("upload"));
    expect(result.commands).toEqual([]);
  });

  it("succeeds on exit code 0 and fails otherwise, keeping the stage", () => {
    const success = transition(running("upload"), {
      type: "PROCESS_EXITED",
      code: 0,
      at: T1,
    });
    expect(success.state.status).toBe("succeeded");

    const failure = transition(running("upload"), {
      type: "PROCESS_EXITED",
      code: 2,
      at: T1,
    });
    expect(failure.state).toEqual({
      status: "failed",
      stage: "upload",
      error: "Deploy exited with code 2",
      startedAt: T0,
      finishedAt: T1,
    });
  });

  it("cancel kills the process and wins over a racing exit", () => {
    const cancelled = transition(running(), { type: "CANCEL", at: T1 });
    expect(cancelled.state.status).toBe("cancelled");
    expect(cancelled.commands).toEqual([{ type: "KillDeploy" }]);

    const staleExit = transition(cancelled.state, {
      type: "PROCESS_EXITED",
      code: null,
      at: T1,
    });
    expect(staleExit.ignoredReason).toBe("not-running");
    expect(staleExit.state.status).toBe("cancelled");
  });

  it("cancel during preflight does not emit a kill", () => {
    const result = transition(
      { status: "preflight", startedAt: T0 },
      { type: "CANCEL", at: T1 },
    );
    expect(result.state.status).toBe("cancelled");
    expect(result.commands).toEqual([]);
  });

  it("ignores stray process/stage events outside running", () => {
    for (const event of [
      { type: "STAGE_MARKER", stage: "upload" },
      { type: "PROCESS_EXITED", code: 0, at: T1 },
    ] as const) {
      const result = transition({ status: "idle" }, event);
      expect(result.ignoredReason).toBe("not-running");
    }
  });
});
