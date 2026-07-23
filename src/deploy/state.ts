/**
 * VPS deploy run lifecycle.
 *
 * The machine models one deploy run per app. The runner (main process) owns
 * side effects: it executes the emitted commands (preflight ssh check,
 * spawning `npm run deploy`, killing the process) and feeds results back as
 * events. Stage granularity inside the running state comes from marker lines
 * the scaffolded deploy script prints; the machine treats them as advisory
 * progress, not control flow.
 */
import type { DeployStage } from "../ipc/types/vps";

export type { DeployStage };

export type DeployState =
  | { status: "idle" }
  | { status: "preflight"; startedAt: number }
  | { status: "running"; stage: DeployStage; startedAt: number }
  | { status: "succeeded"; startedAt: number; finishedAt: number }
  | {
      status: "failed";
      stage: DeployStage | null;
      error: string;
      startedAt: number;
      finishedAt: number;
    }
  | { status: "cancelled"; startedAt: number; finishedAt: number };

export type DeployEvent =
  | { type: "START"; at: number }
  | { type: "PREFLIGHT_PASSED" }
  | { type: "PREFLIGHT_FAILED"; error: string; at: number }
  | { type: "STAGE_MARKER"; stage: DeployStage }
  | { type: "PROCESS_EXITED"; code: number | null; at: number }
  | { type: "CANCEL"; at: number };

export type DeployCommand =
  | { type: "RunPreflight" }
  | { type: "SpawnDeploy" }
  | { type: "KillDeploy" };

export function isDeployActive(state: DeployState): boolean {
  return state.status === "preflight" || state.status === "running";
}
