import { ignore } from "@/state_machines/types";
import type { TransitionResult } from "@/state_machines/types";
import type { DeployCommand, DeployEvent, DeployState } from "./state";
import { isDeployActive } from "./state";

export type DeployTransitionResult = TransitionResult<
  DeployState,
  DeployCommand
>;

export function transition(
  state: DeployState,
  event: DeployEvent,
): DeployTransitionResult {
  switch (event.type) {
    case "START":
      if (isDeployActive(state)) {
        return ignore(state, "deploy-in-flight");
      }
      return {
        state: { status: "preflight", startedAt: event.at },
        commands: [{ type: "RunPreflight" }],
      };

    case "PREFLIGHT_PASSED":
      if (state.status !== "preflight") {
        return ignore(state, "not-in-preflight");
      }
      return {
        state: {
          status: "running",
          stage: "build",
          startedAt: state.startedAt,
        },
        commands: [{ type: "SpawnDeploy" }],
      };

    case "PREFLIGHT_FAILED":
      if (state.status !== "preflight") {
        return ignore(state, "not-in-preflight");
      }
      return {
        state: {
          status: "failed",
          stage: "preflight",
          error: event.error,
          startedAt: state.startedAt,
          finishedAt: event.at,
        },
        commands: [],
      };

    case "STAGE_MARKER":
      if (state.status !== "running") {
        return ignore(state, "not-running");
      }
      if (state.stage === event.stage) {
        return ignore(state, "same-stage");
      }
      return {
        state: { ...state, stage: event.stage },
        commands: [],
      };

    case "PROCESS_EXITED":
      if (state.status !== "running") {
        return ignore(state, "not-running");
      }
      if (event.code === 0) {
        return {
          state: {
            status: "succeeded",
            startedAt: state.startedAt,
            finishedAt: event.at,
          },
          commands: [],
        };
      }
      return {
        state: {
          status: "failed",
          stage: state.stage,
          error:
            event.code === null
              ? "Deploy process was terminated"
              : `Deploy exited with code ${event.code}`,
          startedAt: state.startedAt,
          finishedAt: event.at,
        },
        commands: [],
      };

    case "CANCEL":
      if (state.status !== "preflight" && state.status !== "running") {
        return ignore(state, "not-active");
      }
      return {
        state: {
          status: "cancelled",
          startedAt: state.startedAt,
          finishedAt: event.at,
        },
        // Killing after the state flip means a racing PROCESS_EXITED is
        // ignored as stale rather than overwriting the cancellation.
        commands: state.status === "running" ? [{ type: "KillDeploy" }] : [],
      };

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
