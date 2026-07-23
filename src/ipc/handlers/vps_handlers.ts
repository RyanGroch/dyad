import { BrowserWindow } from "electron";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { getDyadAppPath } from "@/paths/paths";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { deployRunnerHost, DeployRunner } from "@/deploy/runner";
import { isDeployActive } from "@/deploy/state";
import { createTypedHandler } from "./base";
import { vpsContracts, vpsEvents } from "../types/vps";
import {
  deployKeyExists,
  ensureDeployKey,
  isSshAvailable,
  readPublicKey,
  testConnection,
} from "../utils/ssh_utils";
import { readVpsConfig, writeVpsConfig } from "../utils/vps_config";
import { isScaffoldPresent, scaffoldDeployFiles } from "../utils/vps_scaffold";
import { safeSend } from "../utils/safe_sender";

const logger = log.scope("vps_handlers");

async function getAppPath(appId: number): Promise<string> {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!app) {
    throw new DyadError(`App ${appId} not found`, DyadErrorKind.NotFound);
  }
  return getDyadAppPath(app.path);
}

function broadcastSnapshot(appId: number, runner: DeployRunner): void {
  const payload = { appId, snapshot: runner.getSnapshot() };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      safeSend(window.webContents, vpsEvents.deployStatus.channel, payload);
    }
  }
}

async function updateLastDeploy(appId: number, status: string): Promise<void> {
  await db
    .update(apps)
    .set({ vpsLastDeployStatus: status, vpsLastDeployedAt: new Date() })
    .where(eq(apps.id, appId));
}

const watchedApps = new Map<number, string>();

function watchRunner(appId: number): void {
  if (watchedApps.has(appId)) return;
  watchedApps.set(appId, "idle");
  deployRunnerHost.subscribeKey(appId, () => {
    const runner = deployRunnerHost.get(appId);
    if (!runner) return;
    broadcastSnapshot(appId, runner);
    const status = runner.getSnapshot().status;
    const previous = watchedApps.get(appId);
    watchedApps.set(appId, status);
    const isTerminal =
      status === "succeeded" || status === "failed" || status === "cancelled";
    if (isTerminal && previous !== status) {
      void updateLastDeploy(appId, status).catch((err) =>
        logger.error("Failed to persist deploy status", err),
      );
    }
  });
}

export function registerVpsHandlers() {
  createTypedHandler(vpsContracts.getStatus, async (_, { appId }) => {
    const appPath = await getAppPath(appId);
    const config = readVpsConfig(appPath);
    const keyName = config?.keyName;
    return {
      sshAvailable: isSshAvailable(),
      keyExists: deployKeyExists(keyName),
      publicKey: readPublicKey(keyName),
      config,
      scaffoldPresent: isScaffoldPresent(appPath),
    };
  });

  createTypedHandler(vpsContracts.generateKey, async () => {
    const publicKey = await ensureDeployKey();
    return { publicKey };
  });

  createTypedHandler(vpsContracts.testConnection, async (_, { config }) => {
    return testConnection(config);
  });

  createTypedHandler(vpsContracts.saveConfig, async (_, { appId, config }) => {
    const appPath = await getAppPath(appId);
    writeVpsConfig(appPath, config);
  });

  createTypedHandler(vpsContracts.scaffold, async (_, { appId }) => {
    const appPath = await getAppPath(appId);
    if (!readVpsConfig(appPath)) {
      throw new DyadError(
        "Connect a server before generating deploy files",
        DyadErrorKind.Validation,
      );
    }
    return scaffoldDeployFiles(appPath);
  });

  createTypedHandler(vpsContracts.deploy, async (_, { appId }) => {
    const appPath = await getAppPath(appId);
    const config = readVpsConfig(appPath);
    if (!config) {
      throw new DyadError(
        "No dyad.deploy.json found for this app",
        DyadErrorKind.Validation,
      );
    }
    if (!isScaffoldPresent(appPath)) {
      throw new DyadError(
        "No deploy script found. Generate deploy files first.",
        DyadErrorKind.Validation,
      );
    }
    const runner = deployRunnerHost.ensure(appId);
    watchRunner(appId);
    const snapshot = runner.getSnapshot();
    if (snapshot.status === "preflight" || snapshot.status === "running") {
      throw new DyadError(
        "A deploy is already in progress for this app",
        DyadErrorKind.Validation,
      );
    }
    runner.start({ appPath, config });
    logger.info(`Started deploy for app ${appId}`);
  });

  createTypedHandler(vpsContracts.cancelDeploy, async (_, { appId }) => {
    deployRunnerHost.get(appId)?.cancel();
  });

  createTypedHandler(vpsContracts.getDeploySnapshot, async (_, { appId }) => {
    const runner = deployRunnerHost.get(appId);
    if (runner) return runner.getSnapshot();
    return {
      status: "idle" as const,
      stage: null,
      error: null,
      log: "",
      url: null,
      startedAt: null,
      finishedAt: null,
    };
  });

  logger.debug("Registered VPS IPC handlers");
}
