import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

// =============================================================================
// VPS Schemas
// =============================================================================

// Committed to the app repo as dyad.deploy.json. Never holds secrets: the
// private key stays in ~/.ssh and auth is delegated to the system ssh binary.
export const VpsDeployConfigSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  remotePath: z.string().min(1),
  // Optional domain for the site; when set, the scaffold configures Caddy for
  // it (with automatic HTTPS) instead of serving on the bare IP.
  domain: z.string().nullable().default(null),
  // Key file name under ~/.ssh. The scaffold and Dyad both resolve it there.
  keyName: z.string().min(1).default("dyad_deploy_ed25519"),
  // Build output directory uploaded to the server, relative to the app root.
  distDir: z.string().min(1).default("dist"),
});

export type VpsDeployConfig = z.infer<typeof VpsDeployConfigSchema>;

export const VpsConnectionErrorKindSchema = z.enum([
  "unreachable",
  "auth-rejected",
  "host-key-changed",
  "timeout",
  "ssh-missing",
  "unknown",
]);

export type VpsConnectionErrorKind = z.infer<
  typeof VpsConnectionErrorKindSchema
>;

export const VpsTestConnectionResultSchema = z.object({
  ok: z.boolean(),
  errorKind: VpsConnectionErrorKindSchema.optional(),
  error: z.string().optional(),
});

export type VpsTestConnectionResult = z.infer<
  typeof VpsTestConnectionResultSchema
>;

export const VpsFrameworkSchema = z.enum(["vite", "nextjs", "other"]);

export type VpsFramework = z.infer<typeof VpsFrameworkSchema>;

export const VpsCompatSchema = z.object({
  framework: VpsFrameworkSchema,
  recommendedDistDir: z.string(),
  // Whether the static pipeline can serve this app as-is.
  supported: z.boolean(),
  // Hard stops, each with a fix. Non-empty means deploy is refused.
  blockers: z.array(z.string()),
  // Advisory context shown to the user; does not block.
  notes: z.array(z.string()),
});

export type VpsCompat = z.infer<typeof VpsCompatSchema>;

export const VpsStatusSchema = z.object({
  sshAvailable: z.boolean(),
  keyExists: z.boolean(),
  publicKey: z.string().nullable(),
  config: VpsDeployConfigSchema.nullable(),
  scaffoldPresent: z.boolean(),
  compat: VpsCompatSchema,
});

export type VpsStatus = z.infer<typeof VpsStatusSchema>;

export const VpsScaffoldResultSchema = z.object({
  written: z.array(z.string()),
  skipped: z.array(z.string()),
});

export type VpsScaffoldResult = z.infer<typeof VpsScaffoldResultSchema>;

export const DeployStageSchema = z.enum([
  "preflight",
  "build",
  "upload",
  "remote-setup",
  "remote-deploy",
  "finalize",
]);

export type DeployStage = z.infer<typeof DeployStageSchema>;

export const VpsDeploySnapshotSchema = z.object({
  status: z.enum([
    "idle",
    "preflight",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  stage: DeployStageSchema.nullable(),
  error: z.string().nullable(),
  log: z.string(),
  url: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});

export type VpsDeploySnapshot = z.infer<typeof VpsDeploySnapshotSchema>;

export const VpsAppParamsSchema = z.object({
  appId: z.number(),
});

export type VpsAppParams = z.infer<typeof VpsAppParamsSchema>;

export const SaveVpsConfigParamsSchema = z.object({
  appId: z.number(),
  config: VpsDeployConfigSchema,
});

export type SaveVpsConfigParams = z.infer<typeof SaveVpsConfigParamsSchema>;

export const TestVpsConnectionParamsSchema = z.object({
  config: VpsDeployConfigSchema,
});

export type TestVpsConnectionParams = z.infer<
  typeof TestVpsConnectionParamsSchema
>;

// =============================================================================
// VPS Contracts
// =============================================================================

export const vpsContracts = {
  getStatus: defineContract({
    channel: "vps:get-status",
    input: VpsAppParamsSchema,
    output: VpsStatusSchema,
  }),

  generateKey: defineContract({
    channel: "vps:generate-key",
    input: z.void(),
    output: z.object({ publicKey: z.string() }),
  }),

  testConnection: defineContract({
    channel: "vps:test-connection",
    input: TestVpsConnectionParamsSchema,
    output: VpsTestConnectionResultSchema,
  }),

  saveConfig: defineContract({
    channel: "vps:save-config",
    input: SaveVpsConfigParamsSchema,
    output: z.void(),
  }),

  scaffold: defineContract({
    channel: "vps:scaffold",
    input: VpsAppParamsSchema,
    output: VpsScaffoldResultSchema,
  }),

  deploy: defineContract({
    channel: "vps:deploy",
    input: VpsAppParamsSchema,
    output: z.void(),
  }),

  cancelDeploy: defineContract({
    channel: "vps:cancel-deploy",
    input: VpsAppParamsSchema,
    output: z.void(),
  }),

  getDeploySnapshot: defineContract({
    channel: "vps:get-deploy-snapshot",
    input: VpsAppParamsSchema,
    output: VpsDeploySnapshotSchema,
  }),
} as const;

// =============================================================================
// VPS Events (main -> renderer)
// =============================================================================

export const vpsEvents = {
  deployStatus: defineEvent({
    channel: "vps:deploy-status",
    payload: z.object({
      appId: z.number(),
      snapshot: VpsDeploySnapshotSchema,
    }),
  }),
} as const;

// =============================================================================
// VPS Client
// =============================================================================

export const vpsClient = createClient(vpsContracts);

export const vpsEventClient = createEventClient(vpsEvents);
