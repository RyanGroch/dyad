/**
 * Main-process runner for VPS deploys.
 *
 * One runner per app, hosted in a KeyedControllerHost. The runner applies the
 * pure transition, executes emitted commands (preflight, spawn, kill), buffers
 * log output, and exposes a renderer-facing snapshot. The snapshot is
 * broadcast on every change and can be re-fetched after a renderer reload, so
 * a deploy survives closing the panel or reloading the app.
 */
import { spawn, type ChildProcess } from "child_process";
import treeKill from "tree-kill";
import log from "electron-log";
import { KeyedControllerHost } from "@/state_machines/keyed_host";
import { observeTransition } from "@/state_machines/types";
import type { TransitionObserver } from "@/state_machines/types";
import type { VpsDeployConfig, VpsDeploySnapshot } from "@/ipc/types/vps";
import { DeployStageSchema } from "@/ipc/types/vps";
import { testConnection } from "@/ipc/utils/ssh_utils";
import { deployUrl } from "@/ipc/utils/vps_config";
import type { DeployCommand, DeployEvent, DeployState } from "./state";
import { transition } from "./transition";

const logger = log.scope("deploy_runner");

// The scaffolded deploy script prints these lines to report progress.
const STAGE_MARKER_PREFIX = "::dyad-deploy-stage::";

const MAX_LOG_CHARS = 200_000;

export interface DeployRunnerDeps {
  appPath: string;
  config: VpsDeployConfig;
}

export class DeployRunner {
  private state: DeployState = { status: "idle" };
  private logBuffer = "";
  private child: ChildProcess | null = null;
  private deps: DeployRunnerDeps | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly observer: TransitionObserver<
    DeployState,
    DeployEvent,
    DeployCommand
  > = {
    onEventIgnored: ({ event, reason }) => {
      logger.debug(`Ignored deploy event ${event.type}: ${reason}`);
    },
  };

  constructor(private readonly appId: number) {}

  getSnapshot(): VpsDeploySnapshot {
    const state = this.state;
    return {
      status: state.status,
      stage:
        state.status === "running"
          ? state.stage
          : state.status === "failed"
            ? state.stage
            : null,
      error: state.status === "failed" ? state.error : null,
      log: this.logBuffer,
      url:
        state.status === "succeeded" && this.deps
          ? deployUrl(this.deps.config)
          : null,
      startedAt: "startedAt" in state ? state.startedAt : null,
      finishedAt: "finishedAt" in state ? state.finishedAt : null,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.child?.pid) {
      treeKill(this.child.pid, "SIGKILL");
    }
    this.child = null;
    this.listeners.clear();
  }

  start(deps: DeployRunnerDeps): void {
    this.deps = deps;
    this.logBuffer = "";
    this.dispatch({ type: "START", at: Date.now() });
  }

  cancel(): void {
    this.dispatch({ type: "CANCEL", at: Date.now() });
  }

  private dispatch(event: DeployEvent): void {
    const previous = this.state;
    const result = transition(previous, event);
    observeTransition(this.observer, previous, event, result);
    if (result.ignoredReason !== undefined) return;
    this.state = result.state;
    for (const command of result.commands) {
      this.execute(command);
    }
    this.notify();
  }

  private execute(command: DeployCommand): void {
    switch (command.type) {
      case "RunPreflight":
        void this.runPreflight();
        return;
      case "SpawnDeploy":
        this.spawnDeploy();
        return;
      case "KillDeploy":
        if (this.child?.pid) {
          treeKill(this.child.pid, "SIGKILL");
        }
        this.child = null;
        return;
      default: {
        const exhaustive: never = command;
        throw new Error(`Unhandled deploy command: ${exhaustive}`);
      }
    }
  }

  private async runPreflight(): Promise<void> {
    if (!this.deps) return;
    this.appendLog("Checking SSH connection...\n");
    const result = await testConnection(this.deps.config);
    if (result.ok) {
      this.appendLog("SSH connection OK.\n");
      this.dispatch({ type: "PREFLIGHT_PASSED" });
    } else {
      this.appendLog(`SSH connection failed: ${result.error}\n`);
      this.dispatch({
        type: "PREFLIGHT_FAILED",
        error: result.error ?? "SSH connection failed",
        at: Date.now(),
      });
    }
  }

  private spawnDeploy(): void {
    if (!this.deps) return;
    const child = spawn("npm", ["run", "deploy"], {
      cwd: this.deps.appPath,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    this.child = child;

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      this.appendLog(text);
      for (const line of text.split("\n")) {
        if (!line.startsWith(STAGE_MARKER_PREFIX)) continue;
        const parsed = DeployStageSchema.safeParse(
          line.slice(STAGE_MARKER_PREFIX.length).trim(),
        );
        if (parsed.success) {
          this.dispatch({ type: "STAGE_MARKER", stage: parsed.data });
        }
      }
      this.notify();
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      this.appendLog(`Failed to run deploy script: ${err.message}\n`);
      this.child = null;
      this.dispatch({ type: "PROCESS_EXITED", code: 1, at: Date.now() });
    });
    child.on("close", (code) => {
      this.child = null;
      this.dispatch({ type: "PROCESS_EXITED", code, at: Date.now() });
    });
  }

  private appendLog(text: string): void {
    this.logBuffer = (this.logBuffer + text).slice(-MAX_LOG_CHARS);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const deployRunnerHost = new KeyedControllerHost<number, DeployRunner>(
  (appId) => new DeployRunner(appId),
);
