import log from "electron-log";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const logger = log.scope("coolify_client");

// Every scope the integration needs. Coolify fixes these when a token is
// created, so a token missing one fails with 403 rather than degrading.
const REQUIRED_SCOPES = "read, read:sensitive, write, deploy";

export interface CoolifyClientOptions {
  instanceUrl: string;
  token: string;
}

export interface CoolifyDatabase {
  uuid: string;
  name?: string;
  status?: string;
  /** postgres://user:pass@<container-uuid>:5432/db — docker network only. */
  internal_db_url?: string | null;
  /** Only non-null when the database has been made public. */
  external_db_url?: string | null;
}

export interface CoolifyApplication {
  uuid: string;
  name?: string;
  fqdn?: string | null;
}

export interface CoolifyDeployment {
  deployment_uuid?: string;
  status?: string;
}

export class CoolifyClient {
  private readonly base: string;

  constructor(private readonly options: CoolifyClientOptions) {
    this.base = options.instanceUrl.replace(/\/+$/, "");
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new DyadError(
        `Could not reach Coolify at ${this.base}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        DyadErrorKind.External,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw this.toError(method, path, res.status, text);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  private toError(
    method: string,
    path: string,
    status: number,
    text: string,
  ): DyadError {
    const detail = text.slice(0, 300);
    if (status === 401) {
      return new DyadError(
        "Coolify rejected the API token. Check that it is correct and has not been revoked.",
        DyadErrorKind.Validation,
      );
    }
    if (status === 403) {
      return new DyadError(
        `Coolify rejected the request for lack of permissions. The API token ` +
          `needs all of: ${REQUIRED_SCOPES}. Scopes are fixed when a token is ` +
          `created, so create a new token with all of them.`,
        DyadErrorKind.Validation,
      );
    }
    logger.error(`Coolify ${method} ${path} -> ${status}: ${detail}`);
    return new DyadError(
      `Coolify request failed (${status}): ${detail}`,
      DyadErrorKind.External,
    );
  }

  /** Validates the token and returns the reachable servers. */
  async listServers(): Promise<Array<{ uuid: string; name: string }>> {
    const servers = await this.request<Array<{ uuid: string; name: string }>>(
      "GET",
      "/servers",
    );
    return Array.isArray(servers) ? servers : [];
  }

  async listProjects(): Promise<Array<{ uuid: string; name: string }>> {
    const projects = await this.request<Array<{ uuid: string; name: string }>>(
      "GET",
      "/projects",
    );
    return Array.isArray(projects) ? projects : [];
  }

  async createProject(name: string): Promise<{ uuid: string }> {
    return this.request("POST", "/projects", { name });
  }

  async getProject(
    uuid: string,
  ): Promise<{ uuid: string; environments?: Array<{ name: string }> }> {
    return this.request("GET", `/projects/${uuid}`);
  }

  /** Registers a private key so Coolify can clone a private repository. */
  async registerPrivateKey({
    name,
    privateKey,
    description,
  }: {
    name: string;
    privateKey: string;
    description?: string;
  }): Promise<{ uuid: string }> {
    const existing = await this.request<Array<{ uuid: string; name: string }>>(
      "GET",
      "/security/keys",
    ).catch(() => []);
    const match = (Array.isArray(existing) ? existing : []).find(
      (k) => k.name === name,
    );
    if (match) return { uuid: match.uuid };
    return this.request("POST", "/security/keys", {
      name,
      description,
      private_key: privateKey,
    });
  }

  async createPostgres(params: {
    serverUuid: string;
    projectUuid: string;
    environmentName: string;
    name: string;
    user?: string;
    database?: string;
  }): Promise<{ uuid: string }> {
    return this.request("POST", "/databases/postgresql", {
      server_uuid: params.serverUuid,
      project_uuid: params.projectUuid,
      environment_name: params.environmentName,
      name: params.name,
      postgres_user: params.user ?? "dyad",
      postgres_db: params.database ?? "dyad",
      // Deliberately not public: the database stays on the docker network and
      // Dyad reaches it through an SSH tunnel instead.
      is_public: false,
      instant_deploy: true,
    });
  }

  async getDatabase(uuid: string): Promise<CoolifyDatabase> {
    return this.request("GET", `/databases/${uuid}`);
  }

  async createApplicationFromPrivateRepo(params: {
    serverUuid: string;
    projectUuid: string;
    environmentName: string;
    privateKeyUuid: string;
    gitRepository: string;
    gitBranch: string;
    name: string;
    portsExposes: string;
    healthCheckPath?: string;
  }): Promise<{ uuid: string }> {
    return this.request("POST", "/applications/private-deploy-key", {
      server_uuid: params.serverUuid,
      project_uuid: params.projectUuid,
      environment_name: params.environmentName,
      private_key_uuid: params.privateKeyUuid,
      git_repository: params.gitRepository,
      git_branch: params.gitBranch,
      build_pack: "nixpacks",
      name: params.name,
      ports_exposes: params.portsExposes,
      autogenerate_domain: true,
      health_check_enabled: Boolean(params.healthCheckPath),
      health_check_path: params.healthCheckPath,
      instant_deploy: false,
    });
  }

  async getApplication(uuid: string): Promise<CoolifyApplication> {
    return this.request("GET", `/applications/${uuid}`);
  }

  /**
   * Sets an environment variable, updating it when it already exists.
   *
   * `is_literal` stops Coolify interpolating a `$` that can appear in a
   * generated database password. There is no `is_build_time` field — passing
   * one makes the request fail validation.
   */
  async setEnv(
    applicationUuid: string,
    key: string,
    value: string,
  ): Promise<void> {
    const body = { key, value, is_preview: false, is_literal: true };
    try {
      await this.request("POST", `/applications/${applicationUuid}/envs`, body);
    } catch {
      // Already present: Coolify answers 409 on create, so update instead.
      await this.request(
        "PATCH",
        `/applications/${applicationUuid}/envs`,
        body,
      );
    }
  }

  async startApplication(uuid: string): Promise<CoolifyDeployment> {
    return this.request("POST", `/applications/${uuid}/start`, {});
  }

  /**
   * Reads a deployment's status.
   *
   * Note this uses `/deployments/{uuid}`. The similarly named
   * `/deployments/applications/{uuid}` returns Application objects, which carry
   * no deployment status at all.
   */
  async getDeployment(deploymentUuid: string): Promise<CoolifyDeployment> {
    return this.request("GET", `/deployments/${deploymentUuid}`);
  }

  async getApplicationLogs(uuid: string, lines = 50): Promise<unknown> {
    return this.request("GET", `/applications/${uuid}/logs?lines=${lines}`);
  }

  async deleteApplication(uuid: string): Promise<void> {
    await this.request("DELETE", `/applications/${uuid}`);
  }

  async deleteDatabase(uuid: string): Promise<void> {
    await this.request("DELETE", `/databases/${uuid}`);
  }
}
