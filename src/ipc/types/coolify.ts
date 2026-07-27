import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

// =============================================================================
// Coolify Schemas
// =============================================================================

export const CoolifyServerSchema = z.object({
  uuid: z.string(),
  name: z.string(),
});

export type CoolifyServer = z.infer<typeof CoolifyServerSchema>;

export const CoolifyProjectSchema = z.object({
  uuid: z.string(),
  name: z.string(),
});

export type CoolifyProject = z.infer<typeof CoolifyProjectSchema>;

export const CoolifyConnectionSchema = z.object({
  instanceUrl: z.string().url(),
  serverUuid: z.string().min(1),
  projectUuid: z.string().min(1),
  environmentName: z.string().min(1).default("production"),
  // SSH details for the tunnel used to reach a provisioned database. Coolify's
  // API token cannot open one, so this is a separate credential path.
  sshHost: z.string().min(1),
  sshUser: z.string().min(1).default("root"),
  sshPort: z.number().int().min(1).max(65535).default(22),
});

export type CoolifyConnection = z.infer<typeof CoolifyConnectionSchema>;

export const CoolifyStatusSchema = z.object({
  hasToken: z.boolean(),
  sshAvailable: z.boolean(),
  sshKeyExists: z.boolean(),
  sshPublicKey: z.string().nullable(),
  connection: CoolifyConnectionSchema.nullable(),
  appUuid: z.string().nullable(),
  databaseUuid: z.string().nullable(),
  appUrl: z.string().nullable(),
});

export type CoolifyStatus = z.infer<typeof CoolifyStatusSchema>;

export const CoolifyDeployStageSchema = z.enum([
  "preflight",
  "push",
  "provision-database",
  "migrate",
  "create-application",
  "deploy",
  "finalize",
]);

export type CoolifyDeployStage = z.infer<typeof CoolifyDeployStageSchema>;

export const CoolifyDeploySnapshotSchema = z.object({
  status: z.enum(["idle", "running", "succeeded", "failed"]),
  stage: CoolifyDeployStageSchema.nullable(),
  error: z.string().nullable(),
  log: z.string(),
  url: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});

export type CoolifyDeploySnapshot = z.infer<typeof CoolifyDeploySnapshotSchema>;

export const CoolifyAppParamsSchema = z.object({ appId: z.number() });

export const SaveCoolifyTokenParamsSchema = z.object({
  instanceUrl: z.string().url(),
  token: z.string().min(1),
});

export const CoolifyDiscoverySchema = z.object({
  servers: z.array(CoolifyServerSchema),
  projects: z.array(CoolifyProjectSchema),
});

export type CoolifyDiscovery = z.infer<typeof CoolifyDiscoverySchema>;

export const SaveCoolifyConnectionParamsSchema = z.object({
  appId: z.number(),
  connection: CoolifyConnectionSchema,
});

export const DeployToCoolifyParamsSchema = z.object({
  appId: z.number(),
  // When true, Dyad provisions a Postgres on the user's server and wires
  // DATABASE_URL to it. When false the app keeps whatever database it has.
  provisionDatabase: z.boolean().default(false),
});

// =============================================================================
// Coolify Contracts
// =============================================================================

export const coolifyContracts = {
  getStatus: defineContract({
    channel: "coolify:get-status",
    input: CoolifyAppParamsSchema,
    output: CoolifyStatusSchema,
  }),

  // DO NOT LOG: carries an API token.
  saveToken: defineContract({
    channel: "coolify:save-token",
    input: SaveCoolifyTokenParamsSchema,
    output: z.void(),
  }),

  discover: defineContract({
    channel: "coolify:discover",
    input: z.void(),
    output: CoolifyDiscoverySchema,
  }),

  generateSshKey: defineContract({
    channel: "coolify:generate-ssh-key",
    input: z.void(),
    output: z.object({ publicKey: z.string() }),
  }),

  testSsh: defineContract({
    channel: "coolify:test-ssh",
    input: z.object({
      sshHost: z.string(),
      sshUser: z.string(),
      sshPort: z.number(),
    }),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  }),

  saveConnection: defineContract({
    channel: "coolify:save-connection",
    input: SaveCoolifyConnectionParamsSchema,
    output: z.void(),
  }),

  deploy: defineContract({
    channel: "coolify:deploy",
    input: DeployToCoolifyParamsSchema,
    output: z.void(),
  }),

  getDeploySnapshot: defineContract({
    channel: "coolify:get-deploy-snapshot",
    input: CoolifyAppParamsSchema,
    output: CoolifyDeploySnapshotSchema,
  }),

  clearToken: defineContract({
    channel: "coolify:clear-token",
    input: z.void(),
    output: z.void(),
  }),

  createProject: defineContract({
    channel: "coolify:create-project",
    input: z.object({ name: z.string().min(1) }),
    output: CoolifyProjectSchema,
  }),

  setPortableCodegen: defineContract({
    channel: "coolify:set-portable-codegen",
    input: z.object({ appId: z.number(), enabled: z.boolean() }),
    output: z.void(),
  }),

  disconnect: defineContract({
    channel: "coolify:disconnect",
    input: CoolifyAppParamsSchema,
    output: z.void(),
  }),
} as const;

// =============================================================================
// Coolify Events
// =============================================================================

export const coolifyEvents = {
  deployStatus: defineEvent({
    channel: "coolify:deploy-status",
    payload: z.object({
      appId: z.number(),
      snapshot: CoolifyDeploySnapshotSchema,
    }),
  }),
} as const;

// =============================================================================
// Coolify Client
// =============================================================================

export const coolifyClient = createClient(coolifyContracts);
export const coolifyEventClient = createEventClient(coolifyEvents);
