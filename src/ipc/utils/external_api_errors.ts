import log from "electron-log";
import { readSettings } from "@/main/settings";
import { isDyadProEnabled } from "@/lib/schemas";
import { sendTelemetryEvent } from "./telemetry";
import { markExternalApiFailureReported } from "./external_api_error_marks";

const logger = log.scope("external_api");

export type ExternalApiService = "neon" | "vercel";

/**
 * Path segments kept as-is in a route. Anything else becomes `{id}`, so
 * project names, IDs and database names never leave the machine.
 */
const STATIC_PATH_SEGMENTS: Record<ExternalApiService, ReadonlySet<string>> = {
  // Words in the paths of the API endpoints Dyad calls. Version segments
  // such as `v13` are kept separately.
  neon: new Set([
    "auth",
    "branches",
    "connection_uri",
    "databases",
    "domains",
    "email_and_password",
    "endpoints",
    "me",
    "oauth_providers",
    "organizations",
    "projects",
    "restore",
    "roles",
    "users",
  ]),
  vercel: new Set([
    "deployments",
    "domains",
    "env",
    "projects",
    "teams",
    "user",
  ]),
};

const VERSION_SEGMENT = /^v\d{1,3}$/;
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** `/projects/aged-moon-123/branches` becomes `/projects/{id}/branches`. */
export function templateApiRoute(
  service: ExternalApiService,
  path: string,
): string {
  let pathname: string;
  try {
    pathname = new URL(path, "http://route.invalid").pathname;
  } catch {
    return "{unparseable}";
  }
  const known = STATIC_PATH_SEGMENTS[service];
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      known.has(segment) || VERSION_SEGMENT.test(segment) ? segment : "{id}",
    );
  return `/${segments.join("/")}`;
}

/** Only machine-generated codes such as `BRANCHES_LIMIT_EXCEEDED`. */
export function sanitizeProviderErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && ERROR_CODE.test(value)
    ? value
    : undefined;
}

export interface ExternalApiFailure {
  service: ExternalApiService;
  method: string;
  route: string;
  /** HTTP status, or "network" when no response arrived. */
  status: number | "network";
  /** Provider error code, or the network error code. */
  code?: string;
  durationMs: number;
}

/**
 * Log a failed request and send `external_api:error`. The renderer's error
 * deduper handles repeats. 5xx and network failures are usually the service
 * or the user's connection, so their telemetry is sent only for Pro users;
 * every failure is still logged.
 */
export function reportExternalApiFailure(failure: ExternalApiFailure): void {
  try {
    const outcome =
      failure.status === "network" ? "network error" : String(failure.status);
    logger.warn(
      `${failure.service} ${failure.method} ${failure.route} -> ${outcome}${
        failure.code ? ` ${failure.code}` : ""
      } (${Math.round(failure.durationMs)}ms)`,
    );

    const isClientError =
      typeof failure.status === "number" && failure.status < 500;
    if (!isClientError && !isDyadProEnabled(readSettings())) return;

    sendTelemetryEvent("external_api:error", {
      api_service: failure.service,
      api_method: failure.method,
      api_route: failure.route,
      api_status: failure.status,
      api_error_code: failure.code,
      duration_ms: Math.round(failure.durationMs),
    });
  } catch (error) {
    logger.warn("Could not report an external API failure:", error);
  }
}

function isAbortError(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    const code = (current as { code?: unknown } | undefined)?.code;
    const sanitized = sanitizeProviderErrorCode(code);
    if (sanitized) return sanitized;
    current = (current as { cause?: unknown } | undefined)?.cause;
  }
  return undefined;
}

async function readProviderErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as {
      code?: unknown;
      error?: { code?: unknown };
    };
    return sanitizeProviderErrorCode(body?.error?.code ?? body?.code);
  } catch {
    return undefined;
  }
}

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * A fetch that reports failed responses and network errors. The response
 * is returned unread, so callers handle it as before.
 */
export function createExternalApiFetch(
  service: ExternalApiService,
  baseFetch: Fetch = (input, init) => fetch(input, init),
): Fetch {
  return async (input, init) => {
    const startedAt = performance.now();
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const route = templateApiRoute(service, url);

    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (error) {
      if (!isAbortError(error, init?.signal ?? request?.signal)) {
        if (typeof error === "object" && error !== null) {
          markExternalApiFailureReported(error);
        }
        reportExternalApiFailure({
          service,
          method,
          route,
          status: "network",
          code: networkErrorCode(error),
          durationMs: performance.now() - startedAt,
        });
      }
      throw error;
    }

    if (response.status >= 400) {
      markExternalApiFailureReported(response);
      reportExternalApiFailure({
        service,
        method,
        route,
        status: response.status,
        code: await readProviderErrorCode(response),
        durationMs: performance.now() - startedAt,
      });
    }
    return response;
  };
}

interface AxiosLikeRequestConfig {
  method?: string;
  url?: string;
}

interface AxiosLikeError {
  code?: string;
  config?: AxiosLikeRequestConfig;
  response?: { status?: number; data?: unknown };
}

interface AxiosLikeInstance {
  interceptors: {
    request: {
      use(onFulfilled: (config: any) => any): unknown;
    };
    response: {
      use(onFulfilled: undefined, onRejected: (error: any) => any): unknown;
    };
  };
}

/** Report failed requests made through an axios instance. */
export function instrumentAxiosInstance(
  service: ExternalApiService,
  instance: AxiosLikeInstance,
): void {
  const startedAt = new WeakMap<object, number>();
  instance.interceptors.request.use((config: object) => {
    startedAt.set(config, performance.now());
    return config;
  });
  instance.interceptors.response.use(
    undefined,
    (error: AxiosLikeError | undefined) => {
      if (error && typeof error === "object" && error.code !== "ERR_CANCELED") {
        const config = error.config;
        const started = config ? startedAt.get(config) : undefined;
        const status = error.response?.status;
        const data = error.response?.data as { code?: unknown } | undefined;
        markExternalApiFailureReported(error);
        reportExternalApiFailure({
          service,
          method: (config?.method ?? "GET").toUpperCase(),
          route: templateApiRoute(service, config?.url ?? "/"),
          status: typeof status === "number" ? status : "network",
          code:
            typeof status === "number"
              ? sanitizeProviderErrorCode(data?.code)
              : sanitizeProviderErrorCode(error.code),
          durationMs: started === undefined ? 0 : performance.now() - started,
        });
      }
      return Promise.reject(error);
    },
  );
}
