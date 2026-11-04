// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  sendTelemetryEvent: vi.fn(),
  isPro: false,
}));

vi.mock("electron-log", () => ({
  default: { scope: () => ({ warn: mocks.warn }) },
}));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
vi.mock("@/lib/schemas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/schemas")>()),
  isDyadProEnabled: () => mocks.isPro,
}));
vi.mock("./telemetry", () => ({
  sendTelemetryEvent: mocks.sendTelemetryEvent,
}));

import {
  createExternalApiFetch,
  instrumentAxiosInstance,
  reportExternalApiFailure,
  sanitizeProviderErrorCode,
  templateApiRoute,
} from "./external_api_errors";
import { isExternalApiFailureReported } from "./external_api_error_marks";

beforeEach(() => {
  mocks.warn.mockReset();
  mocks.sendTelemetryEvent.mockReset();
  mocks.isPro = false;
});

describe("templateApiRoute", () => {
  it("replaces Neon IDs and names with {id}", () => {
    expect(
      templateApiRoute(
        "neon",
        "/projects/aged-moon-12345678/branches/br-cool-sky-a1b2/databases/neondb",
      ),
    ).toBe("/projects/{id}/branches/{id}/databases/{id}");
  });

  it("keeps Vercel version segments and drops the query string", () => {
    expect(
      templateApiRoute(
        "vercel",
        "https://api.vercel.com/v9/projects/my-secret-app/domains?teamId=team_abc",
      ),
    ).toBe("/v9/projects/{id}/domains");
  });

  it("keeps only the service's own path words", () => {
    expect(templateApiRoute("vercel", "/v2/teams/branches")).toBe(
      "/v2/teams/{id}",
    );
  });
});

describe("sanitizeProviderErrorCode", () => {
  it("keeps machine-generated codes", () => {
    expect(sanitizeProviderErrorCode("BRANCHES_LIMIT_EXCEEDED")).toBe(
      "BRANCHES_LIMIT_EXCEEDED",
    );
    expect(sanitizeProviderErrorCode("forbidden")).toBe("forbidden");
  });

  it("drops anything that could be free text", () => {
    expect(sanitizeProviderErrorCode("Project my-app not found")).toBe(
      undefined,
    );
    expect(sanitizeProviderErrorCode("x".repeat(65))).toBe(undefined);
    expect(sanitizeProviderErrorCode(42)).toBe(undefined);
  });
});

describe("reportExternalApiFailure", () => {
  const failure = {
    service: "neon" as const,
    method: "POST",
    route: "/projects/{id}/branches",
    code: "BRANCHES_LIMIT_EXCEEDED",
    durationMs: 340.4,
  };

  it("logs a warning line", () => {
    reportExternalApiFailure({ ...failure, status: 422 });

    expect(mocks.warn).toHaveBeenCalledWith(
      "neon POST /projects/{id}/branches -> 422 BRANCHES_LIMIT_EXCEEDED (340ms)",
    );
  });

  it("sends 4xx telemetry for everyone", () => {
    reportExternalApiFailure({ ...failure, status: 422 });

    expect(mocks.sendTelemetryEvent).toHaveBeenCalledWith(
      "external_api:error",
      {
        api_service: "neon",
        api_method: "POST",
        api_route: "/projects/{id}/branches",
        api_status: 422,
        api_error_code: "BRANCHES_LIMIT_EXCEEDED",
        duration_ms: 340,
      },
    );
  });

  it.each([503, "network" as const])(
    "logs but sends no telemetry for a free user's %s",
    (status) => {
      reportExternalApiFailure({ ...failure, status });

      expect(mocks.warn).toHaveBeenCalled();
      expect(mocks.sendTelemetryEvent).not.toHaveBeenCalled();
    },
  );

  it.each([503, "network" as const])(
    "sends telemetry for a Pro user's %s",
    (status) => {
      mocks.isPro = true;
      reportExternalApiFailure({ ...failure, status });

      expect(mocks.sendTelemetryEvent).toHaveBeenCalledWith(
        "external_api:error",
        expect.objectContaining({ api_status: status }),
      );
    },
  );
});

describe("createExternalApiFetch", () => {
  it("reports a failed response and returns it unread", async () => {
    const response = new Response(
      JSON.stringify({ error: { code: "bad_request", message: "secret" } }),
      { status: 400 },
    );
    const fetchVercel = createExternalApiFetch("vercel", async () => response);

    const result = await fetchVercel(
      new Request("https://api.vercel.com/v13/deployments?teamId=t", {
        method: "POST",
      }),
    );

    expect(result).toBe(response);
    expect(await result.json()).toMatchObject({
      error: { code: "bad_request" },
    });
    expect(isExternalApiFailureReported({ rawResponse: response })).toBe(true);
    expect(mocks.sendTelemetryEvent).toHaveBeenCalledWith(
      "external_api:error",
      expect.objectContaining({
        api_service: "vercel",
        api_method: "POST",
        api_route: "/v13/deployments",
        api_status: 400,
        api_error_code: "bad_request",
      }),
    );
    expect(JSON.stringify(mocks.sendTelemetryEvent.mock.calls)).not.toContain(
      "secret",
    );
  });

  it("does not report a successful response", async () => {
    const fetchVercel = createExternalApiFetch(
      "vercel",
      async () => new Response("{}", { status: 200 }),
    );

    await fetchVercel("https://api.vercel.com/v2/user");

    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("reports a network failure with its code and rethrows it", async () => {
    mocks.isPro = true;
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect"), { code: "ECONNRESET" }),
    });
    const fetchVercel = createExternalApiFetch("vercel", async () => {
      throw error;
    });

    await expect(fetchVercel("https://api.vercel.com/v2/user")).rejects.toBe(
      error,
    );
    expect(isExternalApiFailureReported(error)).toBe(true);
    expect(mocks.sendTelemetryEvent).toHaveBeenCalledWith(
      "external_api:error",
      expect.objectContaining({
        api_status: "network",
        api_error_code: "ECONNRESET",
      }),
    );
  });

  it("does not report a cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchVercel = createExternalApiFetch("vercel", async () => {
      throw new DOMException("aborted", "AbortError");
    });

    await expect(
      fetchVercel("https://api.vercel.com/v2/user", {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe("instrumentAxiosInstance", () => {
  function fakeAxios() {
    let onRequest: (config: object) => object = (config) => config;
    let onRejected: (error: unknown) => Promise<never> = (error) =>
      Promise.reject(error);
    const instance = {
      interceptors: {
        request: {
          use: (fn: typeof onRequest) => {
            onRequest = fn;
          },
        },
        response: {
          use: (_ok: undefined, fn: typeof onRejected) => {
            onRejected = fn;
          },
        },
      },
    };
    return {
      instance,
      fail: (config: object, error: object) => {
        onRequest(config);
        return onRejected({ ...error, config });
      },
    };
  }

  it("reports an HTTP error with the provider's code", async () => {
    const axios = fakeAxios();
    instrumentAxiosInstance("neon", axios.instance);

    await expect(
      axios.fail(
        { method: "post", url: "/projects/aged-moon-123/branches" },
        {
          response: {
            status: 422,
            data: { code: "BRANCHES_LIMIT_EXCEEDED", message: "app-name" },
          },
        },
      ),
    ).rejects.toMatchObject({ response: { status: 422 } });

    expect(mocks.sendTelemetryEvent).toHaveBeenCalledWith(
      "external_api:error",
      expect.objectContaining({
        api_service: "neon",
        api_method: "POST",
        api_route: "/projects/{id}/branches",
        api_status: 422,
        api_error_code: "BRANCHES_LIMIT_EXCEEDED",
      }),
    );
  });

  it("does not report a cancelled request", async () => {
    const axios = fakeAxios();
    instrumentAxiosInstance("neon", axios.instance);

    await expect(
      axios.fail({ method: "get", url: "/projects" }, { code: "ERR_CANCELED" }),
    ).rejects.toBeDefined();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe("Vercel SDK errors", () => {
  it("are recognised as already reported", async () => {
    const { Vercel } = await import("@vercel/sdk");
    const { HTTPClient } = await import("@vercel/sdk/lib/http.js");
    const fetcher = createExternalApiFetch(
      "vercel",
      async () =>
        new Response(JSON.stringify({ error: { code: "forbidden" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const vercel = new Vercel({
      bearerToken: "token",
      httpClient: new HTTPClient({ fetcher }),
    });

    const error = await vercel.user.getAuthUser().catch((e: unknown) => e);

    expect(isExternalApiFailureReported(error)).toBe(true);
    const { getVercelDeploymentError, getVercelProjectCreationError } =
      await import("./vercel_errors");
    expect(isExternalApiFailureReported(getVercelDeploymentError(error))).toBe(
      true,
    );
    expect(
      isExternalApiFailureReported(getVercelProjectCreationError(error)),
    ).toBe(true);
    expect(mocks.sendTelemetryEvent).toHaveBeenCalledWith(
      "external_api:error",
      expect.objectContaining({
        api_route: "/v2/user",
        api_status: 403,
        api_error_code: "forbidden",
      }),
    );
  });
});

describe("Neon API client errors", () => {
  it("are reported through the client's axios instance", async () => {
    const http = await import("node:http");
    const { createApiClient } = await import("@neondatabase/api-client");
    const server = http.createServer((_req, res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "BRANCHES_LIMIT_EXCEEDED" }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    try {
      const client = createApiClient({
        apiKey: "key",
        baseURL: `http://127.0.0.1:${port}`,
      });
      instrumentAxiosInstance("neon", client.instance);

      const error = await client
        .createProjectBranch("aged-moon-123", {})
        .catch((e: unknown) => e);

      expect(isExternalApiFailureReported(error)).toBe(true);
      expect(mocks.sendTelemetryEvent).toHaveBeenCalledWith(
        "external_api:error",
        expect.objectContaining({
          api_method: "POST",
          api_route: "/projects/{id}/branches",
          api_status: 422,
          api_error_code: "BRANCHES_LIMIT_EXCEEDED",
        }),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
