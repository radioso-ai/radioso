import { describe, expect, it, vi } from "vitest";

import {
  createOpenApiToolService,
  type OpenApiDocument,
  type ToolFetch,
  type ToolFetchResponse,
} from "../src/index.js";

const spec: OpenApiDocument = {
  openapi: "3.0.0",
  servers: [{ url: "http://api.test" }],
  paths: {
    "/records/{id}": {
      get: {
        operationId: "getRecord",
        description: "Gets a record",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "expand", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
  },
};

describe("OpenAPI adapter", () => {
  it("exposes operations as tools", async () => {
    const service = createOpenApiToolService({ spec });

    await expect(service.listTools()).resolves.toEqual([expect.objectContaining({
      name: "getRecord",
      description: "Gets a record",
      metadata: {
        transport: "openapi",
        method: "get",
        path: "/records/{id}",
        operationId: "getRecord",
      },
    })]);
  });

  it("calls OpenAPI operations without network in tests", async () => {
    const fetchMock = vi.fn<ToolFetch>(async (url, init): Promise<ToolFetchResponse> => {
      expect(String(url)).toBe("http://api.test/records/rec_1?expand=owner");
      expect(init?.method).toBe("GET");
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return { id: "rec_1", title: "Record" };
        },
        async text() {
          return "";
        },
      };
    });
    const service = createOpenApiToolService({ spec, fetch: fetchMock });

    await expect(service.callTool({
      toolName: "getRecord",
      input: { path: { id: "rec_1" }, query: { expand: "owner" } },
    })).resolves.toMatchObject({
      status: "completed",
      outputs: {
        status: 200,
        body: { id: "rec_1", title: "Record" },
      },
    });
  });

  it("maps flat OpenAPI parameters by location", async () => {
    const fetchMock = vi.fn<ToolFetch>(async (url, init): Promise<ToolFetchResponse> => {
      expect(String(url)).toBe("http://api.test/records/rec_1?expand=owner");
      expect(init?.headers).toMatchObject({ "x-request-id": "req_1" });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        async json() {
          return { id: "rec_1" };
        },
        async text() {
          return "";
        },
      };
    });
    const service = createOpenApiToolService({
      spec: {
        ...spec,
        paths: {
          "/records/{id}": {
            get: {
              ...spec.paths["/records/{id}"]?.get,
              operationId: "getRecord",
              parameters: [
                { name: "id", in: "path", required: true, schema: { type: "string" } },
                { name: "expand", in: "query", schema: { type: "string" } },
                { name: "x-request-id", in: "header", schema: { type: "string" } },
              ],
            },
          },
        },
      },
      fetch: fetchMock,
    });

    await expect(service.callTool({
      toolName: "getRecord",
      input: { id: "rec_1", expand: "owner", "x-request-id": "req_1" },
    })).resolves.toMatchObject({ status: "completed" });
  });

  it("blocks non-http OpenAPI operation URLs before fetch", async () => {
    const fetchMock = vi.fn<ToolFetch>();
    const service = createOpenApiToolService({
      spec,
      baseUrl: "file:///etc/passwd",
      fetch: fetchMock,
    });

    await expect(service.callTool({
      toolName: "getRecord",
      input: { path: { id: "rec_1" } },
    })).rejects.toThrow('OpenAPI operation URL must use http or https, got "file:"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks OpenAPI operation hosts outside the allowlist before fetch", async () => {
    const fetchMock = vi.fn<ToolFetch>();
    const service = createOpenApiToolService({
      spec,
      allowedHosts: ["allowed.test"],
      fetch: fetchMock,
    });

    await expect(service.callTool({
      toolName: "getRecord",
      input: { path: { id: "rec_1" } },
    })).rejects.toThrow('OpenAPI operation URL host "api.test" is not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns failed tool results for non-2xx OpenAPI responses", async () => {
    const fetchMock = vi.fn<ToolFetch>(async (): Promise<ToolFetchResponse> => ({
      ok: false,
      status: 502,
      headers: { get: () => "application/json" },
      async json() {
        return { error: "bad gateway" };
      },
      async text() {
        return "";
      },
    }));
    const service = createOpenApiToolService({ spec, fetch: fetchMock });

    await expect(service.callTool({
      toolName: "getRecord",
      input: { path: { id: "rec_1" } },
    })).resolves.toMatchObject({
      status: "failed",
      outputs: {
        status: 502,
        body: { error: "bad gateway" },
      },
      error: {
        code: "openapi_http_error",
        message: 'OpenAPI operation "getRecord" returned HTTP 502',
        retryable: true,
      },
    });
  });
});
