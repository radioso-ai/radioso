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
});
