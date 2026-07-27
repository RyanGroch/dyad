import { BrowserWindow } from "electron";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { readSettings, writeSettings } from "../../main/settings";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { createTypedHandler } from "./base";
import { coolifyContracts, coolifyEvents } from "../types/coolify";
import type {
  CoolifyConnection,
  CoolifyDeploySnapshot,
  CoolifyDeployStage,
} from "../types/coolify";
import { CoolifyClient } from "../utils/coolify_client";
import { safeSend } from "../utils/safe_sender";
import {
  deployKeyExists,
  ensureDeployKey,
  isSshAvailable,
  keyFilePath,
  readPublicKey,
  testConnection,
  type SshTarget,
} from "../utils/ssh_utils";
import { withDatabaseTunnel } from "../utils/ssh_tunnel";
import { generateNeonMigrationStatements } from "../utils/migration_utils";
import { executePostgresStatementsInTransaction } from "@/postgres_admin/postgres_context";
import { getConnectionUri } from "@/neon_admin/neon_context";
import * as fs from "fs";

const logger = log.scope("coolify_handlers");

const MAX_LOG_CHARS = 200_000;
const DEPLOY_POLL_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Deploy runner
// ---------------------------------------------------------------------------

const snapshots = new Map<number, CoolifyDeploySnapshot>();

function idleSnapshot(): CoolifyDeploySnapshot {
  return {
    status: "idle",
    stage: null,
    error: null,
    log: "",
    url: null,
    startedAt: null,
    finishedAt: null,
  };
}

function getSnapshot(appId: number): CoolifyDeploySnapshot {
  return snapshots.get(appId) ?? idleSnapshot();
}

function broadcast(appId: number): void {
  const payload = { appId, snapshot: getSnapshot(appId) };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      safeSend(window.webContents, coolifyEvents.deployStatus.channel, payload);
    }
  }
}

function update(
  appId: number,
  patch: Partial<CoolifyDeploySnapshot>,
  appendLog?: string,
): void {
  const current = getSnapshot(appId);
  const next: CoolifyDeploySnapshot = { ...current, ...patch };
  if (appendLog) {
    next.log = (current.log + appendLog).slice(-MAX_LOG_CHARS);
  }
  snapshots.set(appId, next);
  broadcast(appId);
}

function stage(appId: number, s: CoolifyDeployStage, message: string): void {
  update(appId, { stage: s }, `${message}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClient(): CoolifyClient {
  const settings = readSettings();
  const token = settings.coolifyAccessToken?.value;
  const instanceUrl = settings.coolifyInstanceUrl;
  if (!token || !instanceUrl) {
    throw new DyadError(
      "Coolify is not connected. Add your instance URL and API token first.",
      DyadErrorKind.Validation,
    );
  }
  return new CoolifyClient({ instanceUrl, token });
}

async function getApp(appId: number) {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!app) {
    throw new DyadError(`App ${appId} not found`, DyadErrorKind.NotFound);
  }
  return app;
}

function readConnection(app: {
  coolifyServerUuid: string | null;
  coolifyProjectUuid: string | null;
  coolifyEnvironmentName: string | null;
  coolifySshHost: string | null;
  coolifySshUser: string | null;
  coolifySshPort: number | null;
}): CoolifyConnection | null {
  const settings = readSettings();
  if (
    !settings.coolifyInstanceUrl ||
    !app.coolifyServerUuid ||
    !app.coolifyProjectUuid ||
    !app.coolifySshHost
  ) {
    return null;
  }
  return {
    instanceUrl: settings.coolifyInstanceUrl,
    serverUuid: app.coolifyServerUuid,
    projectUuid: app.coolifyProjectUuid,
    environmentName: app.coolifyEnvironmentName ?? "production",
    sshHost: app.coolifySshHost,
    sshUser: app.coolifySshUser ?? "root",
    sshPort: app.coolifySshPort ?? 22,
  };
}

function sshTargetFor(connection: CoolifyConnection): SshTarget {
  return {
    host: connection.sshHost,
    user: connection.sshUser,
    port: connection.sshPort,
  };
}

/**
 * Diffs the app's Neon development database against the Coolify-provisioned
 * production database and applies the delta. The production database is only
 * reachable through the SSH tunnel, which also encrypts the connection.
 */
/**
 * Waits until a provisioned database is actually running.
 *
 * Creating one only queues it, so the container does not exist for a while
 * afterwards and inspecting it fails with "no such object".
 */
async function waitForDatabaseRunning({
  appId,
  databaseUuid,
}: {
  appId: number;
  databaseUuid: string;
}): Promise<void> {
  const client = getClient();
  const deadline = Date.now() + 3 * 60 * 1000;
  let sawStatus = false;
  while (Date.now() < deadline) {
    const database = await client.getDatabase(databaseUuid);
    const status = String(database.status ?? "");
    if (status) {
      sawStatus = true;
      if (status.startsWith("running")) {
        update(appId, {}, `Database is running (${status}).\n`);
        return;
      }
    }
    update(appId, {}, `  waiting for database... ${status || "(no status)"}\n`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new DyadError(
    sawStatus
      ? "The database did not start in time."
      : "Coolify never reported a database status, so it could not be confirmed running.",
    DyadErrorKind.External,
  );
}

async function migrateProduction({
  appId,
  connection,
  databaseUuid,
  devConnectionString,
}: {
  appId: number;
  connection: CoolifyConnection;
  databaseUuid: string;
  devConnectionString: string;
}): Promise<void> {
  const client = getClient();
  const database = await client.getDatabase(databaseUuid);
  const internalUrl = database.internal_db_url;
  if (!internalUrl) {
    throw new DyadError(
      "Coolify did not return the database connection string. The API token " +
        "needs the read:sensitive scope.",
      DyadErrorKind.Validation,
    );
  }
  // The internal URL's host is the container name, which only resolves inside
  // the docker network; the tunnel rewrites it to the local end.
  const containerName = new URL(internalUrl).hostname;

  await withDatabaseTunnel(
    { target: sshTargetFor(connection), containerName },
    async (rewrite) => {
      const prodUrl = rewrite(internalUrl);
      const statements = await generateNeonMigrationStatements({
        currentDatabaseUrl: prodUrl,
        desiredDatabaseUrl: devConnectionString,
      });
      if (statements.length === 0) {
        update(appId, {}, "Schema already up to date.\n");
        return;
      }
      update(
        appId,
        {},
        `Applying ${statements.length} schema statement(s) to production...\n`,
      );
      await executePostgresStatementsInTransaction({
        connectionString: prodUrl,
        statements: statements.map((s) => s.sql),
      });
      update(appId, {}, "Schema applied.\n");
    },
  );
}

async function resolveDevConnectionString(app: {
  neonProjectId: string | null;
  neonDevelopmentBranchId: string | null;
}): Promise<string | null> {
  if (!app.neonProjectId || !app.neonDevelopmentBranchId) return null;
  return getConnectionUri({
    projectId: app.neonProjectId,
    branchId: app.neonDevelopmentBranchId,
  });
}

async function runDeploy({
  appId,
  provisionDatabase,
}: {
  appId: number;
  provisionDatabase: boolean;
}): Promise<void> {
  const startedAt = Date.now();
  update(appId, {
    status: "running",
    stage: "preflight",
    error: null,
    log: "",
    url: null,
    startedAt,
    finishedAt: null,
  });

  try {
    const app = await getApp(appId);
    const connection = readConnection(app);
    if (!connection) {
      throw new DyadError(
        "Connect a Coolify server for this app first.",
        DyadErrorKind.Validation,
      );
    }
    if (!app.githubOrg || !app.githubRepo) {
      throw new DyadError(
        "Coolify deploys from a git repository. Connect this app to GitHub first.",
        DyadErrorKind.Validation,
      );
    }

    const client = getClient();
    stage(appId, "preflight", "Checking SSH access to the server...");
    const sshCheck = await testConnection(sshTargetFor(connection));
    if (!sshCheck.ok) {
      throw new DyadError(
        `Cannot reach the server over SSH: ${sshCheck.error}`,
        DyadErrorKind.External,
      );
    }
    update(appId, {}, "SSH OK.\n");

    let databaseUuid = app.coolifyDatabaseUuid;
    if (provisionDatabase) {
      if (databaseUuid) {
        update(appId, {}, `Reusing database ${databaseUuid}.\n`);
      } else {
        stage(appId, "provision-database", "Provisioning Postgres...");
        const created = await client.createPostgres({
          serverUuid: connection.serverUuid,
          projectUuid: connection.projectUuid,
          environmentName: connection.environmentName,
          name: `dyad-${app.name}-db`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        });
        databaseUuid = created.uuid;
        await db
          .update(apps)
          .set({ coolifyDatabaseUuid: databaseUuid })
          .where(eq(apps.id, appId));
        update(appId, {}, `Database created (${databaseUuid}).\n`);
      }

      await waitForDatabaseRunning({ appId, databaseUuid });

      const devConnectionString = await resolveDevConnectionString(app);
      if (devConnectionString) {
        stage(
          appId,
          "migrate",
          "Migrating production schema over SSH tunnel...",
        );
        await migrateProduction({
          appId,
          connection,
          databaseUuid,
          devConnectionString,
        });
      } else {
        update(
          appId,
          {},
          "No development database connected; skipping schema migration.\n",
        );
      }
    }

    let applicationUuid = app.coolifyApplicationUuid;
    if (!applicationUuid) {
      stage(appId, "create-application", "Creating the Coolify application...");
      const privateKey = fs.readFileSync(keyFilePath(), "utf8");
      const key = await client.registerPrivateKey({
        name: "dyad-deploy",
        description: "Key Dyad uses to let Coolify clone private repositories",
        privateKey,
      });
      const created = await client.createApplicationFromPrivateRepo({
        serverUuid: connection.serverUuid,
        projectUuid: connection.projectUuid,
        environmentName: connection.environmentName,
        privateKeyUuid: key.uuid,
        gitRepository: `git@github.com:${app.githubOrg}/${app.githubRepo}.git`,
        gitBranch: app.githubBranch ?? "main",
        name: `dyad-${app.name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        portsExposes: "3000",
      });
      applicationUuid = created.uuid;
      await db
        .update(apps)
        .set({ coolifyApplicationUuid: applicationUuid })
        .where(eq(apps.id, appId));
      update(appId, {}, `Application created (${applicationUuid}).\n`);
    }

    if (provisionDatabase && databaseUuid) {
      const database = await client.getDatabase(databaseUuid);
      if (database.internal_db_url) {
        await client.setEnv(
          applicationUuid,
          "DATABASE_URL",
          database.internal_db_url,
        );
        update(appId, {}, "DATABASE_URL wired to the application.\n");
      }
    }

    stage(appId, "deploy", "Deploying...");
    const deployment = await client.startApplication(applicationUuid);
    const deploymentUuid = deployment.deployment_uuid;
    let status = "unknown";
    const pollStart = Date.now();
    while (deploymentUuid && Date.now() - pollStart < DEPLOY_POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 10_000));
      const entry = await client
        .getDeployment(deploymentUuid)
        .catch(() => null);
      status = entry?.status ?? "unknown";
      update(appId, {}, `  status: ${status}\n`);
      if (
        ["finished", "failed", "error", "cancelled-by-user"].includes(status)
      ) {
        break;
      }
    }
    if (status !== "finished") {
      // The status alone says nothing about the cause, so pull the build log.
      let detail = "";
      if (deploymentUuid) {
        const entry = await client
          .getDeployment(deploymentUuid)
          .catch(() => null);
        const logs = (entry as { logs?: string } | null)?.logs;
        if (logs) {
          const tail = logs.slice(-4000);
          update(appId, {}, `\n--- deployment log ---\n${tail}\n`);
          detail = ` Check the deployment log above.`;
        }
      }
      throw new DyadError(
        `Deployment did not finish (last status: ${status}).${detail}`,
        DyadErrorKind.External,
      );
    }

    stage(appId, "finalize", "Resolving the application URL...");
    const application = await client.getApplication(applicationUuid);
    const url = (application.fqdn ?? "").split(",")[0] || null;
    await db
      .update(apps)
      .set({ coolifyAppUrl: url, coolifyLastDeployedAt: new Date() })
      .where(eq(apps.id, appId));

    update(appId, {
      status: "succeeded",
      stage: null,
      url,
      finishedAt: Date.now(),
    });
    logger.info(`Coolify deploy succeeded for app ${appId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Coolify deploy failed for app ${appId}: ${message}`);
    update(
      appId,
      { status: "failed", error: message, finishedAt: Date.now() },
      `\nFailed: ${message}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCoolifyHandlers() {
  createTypedHandler(coolifyContracts.getStatus, async (_, { appId }) => {
    const app = await getApp(appId);
    const settings = readSettings();
    return {
      hasToken: Boolean(settings.coolifyAccessToken?.value),
      sshAvailable: isSshAvailable(),
      sshKeyExists: deployKeyExists(),
      sshPublicKey: readPublicKey(),
      connection: readConnection(app),
      appUuid: app.coolifyApplicationUuid,
      databaseUuid: app.coolifyDatabaseUuid,
      appUrl: app.coolifyAppUrl,
    };
  });

  // DO NOT LOG this handler: it carries an API token.
  createTypedHandler(
    coolifyContracts.saveToken,
    async (_, { instanceUrl, token }) => {
      const probe = new CoolifyClient({ instanceUrl, token });
      // Validates the token and the URL in one call, surfacing scope problems
      // immediately rather than at deploy time.
      await probe.listServers();
      writeSettings({
        coolifyInstanceUrl: instanceUrl.replace(/\/+$/, ""),
        coolifyAccessToken: { value: token },
      });
    },
  );

  createTypedHandler(coolifyContracts.discover, async () => {
    const client = getClient();
    const [servers, projects] = await Promise.all([
      client.listServers(),
      client.listProjects(),
    ]);
    return { servers, projects };
  });

  createTypedHandler(coolifyContracts.clearToken, async () => {
    writeSettings({
      coolifyInstanceUrl: undefined,
      coolifyAccessToken: undefined,
    });
  });

  createTypedHandler(coolifyContracts.createProject, async (_, { name }) => {
    const client = getClient();
    const created = await client.createProject(name);
    return { uuid: created.uuid, name };
  });

  createTypedHandler(coolifyContracts.generateSshKey, async () => {
    return { publicKey: await ensureDeployKey() };
  });

  createTypedHandler(
    coolifyContracts.testSsh,
    async (_, { sshHost, sshUser, sshPort }) => {
      const result = await testConnection({
        host: sshHost,
        user: sshUser,
        port: sshPort,
      });
      return { ok: result.ok, error: result.error };
    },
  );

  createTypedHandler(
    coolifyContracts.saveConnection,
    async (_, { appId, connection }) => {
      await db
        .update(apps)
        .set({
          coolifyServerUuid: connection.serverUuid,
          coolifyProjectUuid: connection.projectUuid,
          coolifyEnvironmentName: connection.environmentName,
          coolifySshHost: connection.sshHost,
          coolifySshUser: connection.sshUser,
          coolifySshPort: connection.sshPort,
        })
        .where(eq(apps.id, appId));
    },
  );

  createTypedHandler(
    coolifyContracts.deploy,
    async (_, { appId, provisionDatabase }) => {
      const current = getSnapshot(appId);
      if (current.status === "running") {
        throw new DyadError(
          "A deploy is already in progress for this app",
          DyadErrorKind.Validation,
        );
      }
      // Deliberately not awaited: progress reaches the renderer through
      // deploy-status events while this returns immediately.
      void runDeploy({ appId, provisionDatabase });
    },
  );

  createTypedHandler(coolifyContracts.getDeploySnapshot, async (_, { appId }) =>
    getSnapshot(appId),
  );

  createTypedHandler(
    coolifyContracts.setPortableCodegen,
    async (_, { appId, enabled }) => {
      await db
        .update(apps)
        .set({ portableCodegen: enabled })
        .where(eq(apps.id, appId));
    },
  );

  createTypedHandler(coolifyContracts.disconnect, async (_, { appId }) => {
    await db
      .update(apps)
      .set({
        coolifyServerUuid: null,
        coolifyProjectUuid: null,
        coolifyEnvironmentName: null,
        coolifySshHost: null,
        coolifySshUser: null,
        coolifySshPort: null,
        coolifyApplicationUuid: null,
        coolifyDatabaseUuid: null,
        coolifyAppUrl: null,
      })
      .where(eq(apps.id, appId));
    snapshots.delete(appId);
  });

  logger.debug("Registered Coolify IPC handlers");
}
