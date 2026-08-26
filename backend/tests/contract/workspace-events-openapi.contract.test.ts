import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";

describe("workspace events OpenAPI contract", () => {
  it("publishes the dashboard-session-only SSE stream and retry contract", () => {
    const document = createOpenApiDocument();
    const operation = document.paths?.["/api/v1/events"]?.get;

    expect(operation).toMatchObject({
      operationId: "streamWorkspaceEvents",
      security: [{ sessionCookie: [], workspaceSelection: [] }],
      responses: {
        "200": {
          headers: {
            "Cache-Control": expect.any(Object),
            Connection: expect.any(Object),
            "X-Accel-Buffering": expect.any(Object),
          },
          content: {
            "text/event-stream": {
              schema: { $ref: "#/components/schemas/WorkspaceEventStream" },
            },
          },
        },
        "400": expect.any(Object),
        "401": expect.any(Object),
        "403": expect.any(Object),
        "404": expect.any(Object),
        "405": expect.any(Object),
        "429": { headers: { "Retry-After": expect.any(Object) } },
        "503": { headers: { "Retry-After": expect.any(Object) } },
      },
    });
    expect(operation?.security).not.toEqual(expect.arrayContaining([{ bearerAuth: [] }]));
    expect(operation?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "header", name: "Accept", required: true }),
    ]));
  });

  it("publishes the versioned ready, invalidate, and resync data shapes", () => {
    const schemas = createOpenApiDocument().components?.schemas;

    expect(schemas?.WorkspaceEventReadyData).toMatchObject({
      type: "object",
      required: ["protocolVersion"],
      properties: { protocolVersion: { type: "number", enum: [1] } },
    });
    expect(schemas?.WorkspaceEventInvalidateData).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["protocolVersion", "changeKinds"]),
      properties: {
        protocolVersion: { type: "number", enum: [1] },
        changeKinds: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          uniqueItems: true,
          items: { $ref: "#/components/schemas/WorkspaceInvalidationKind" },
        },
      },
    });
    expect(schemas?.WorkspaceEventResyncData).toMatchObject({
      type: "object",
      required: ["protocolVersion"],
      properties: { protocolVersion: { type: "number", enum: [1] } },
    });
  });

  it("keeps the stream out of API-token convenience methods and MCP tools", async () => {
    const [generatedClient, mcpReadTools, mcpWriteTools] = await Promise.all([
      readFile(new URL("../../../typescript-sdk/src/generated/client.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../packages/radioso-mcp-server/src/tools/readTools.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../packages/radioso-mcp-server/src/tools/writeTools.ts", import.meta.url), "utf8"),
    ]);

    expect(generatedClient).not.toContain("streamWorkspaceEvents");
    expect(`${mcpReadTools}\n${mcpWriteTools}`).not.toMatch(/workspace[_ -]?events|streamWorkspaceEvents/i);
  });
});
