import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";

describe("workspace events OpenAPI contract", () => {
  it("publishes the dashboard-session-only SSE stream and retry contract", () => {
    const document = createOpenApiDocument();
    const operation = document.paths?.["/api/v1/events"]?.get;

    expect(operation).toMatchObject({
      operationId: "streamWorkspaceEvents",
      security: [{ sessionCookie: [] }],
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
      expect.objectContaining({ in: "header", name: "X-Workspace-Id", required: true }),
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
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          description: expect.stringMatching(/known.*document\.status_changed.*unknown future/iu),
        },
      },
    });
    const invalidateSchema = schemas?.WorkspaceEventInvalidateData as {
      properties?: { changeKinds?: Record<string, unknown> }
    } | undefined;
    expect(invalidateSchema?.properties?.changeKinds).not.toHaveProperty("maxItems");
    expect(invalidateSchema?.properties?.changeKinds?.items).not.toHaveProperty("$ref");
    expect(schemas?.WorkspaceEventResyncData).toMatchObject({
      type: "object",
      required: ["protocolVersion"],
      properties: { protocolVersion: { type: "number", enum: [1] } },
    });
  });

  it("types the browser-only stream without adding API-token convenience or MCP surfaces", async () => {
    const [generatedClient, generatedTypes, mcpServer, mcpConverseTools] = await Promise.all([
      readFile(new URL("../../../typescript-sdk/src/generated/client.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../typescript-sdk/src/generated/types.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../packages/radioso-mcp-server/src/server.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../packages/radioso-mcp-server/src/tools/converseTools.ts", import.meta.url), "utf8"),
    ]);

    expect(generatedClient).not.toContain("streamWorkspaceEvents");
    const generatedOperation = generatedTypes.match(/streamWorkspaceEvents: \{[\s\S]*?^    \};/m)?.[0];
    expect(generatedOperation).toContain('"X-Workspace-Id": string;');
    const generatedInvalidateData = generatedTypes.match(/WorkspaceEventInvalidateData: \{[\s\S]*?^        \};/m)?.[0];
    expect(generatedInvalidateData).toContain("changeKinds: string[];");
    expect(generatedInvalidateData).not.toContain("WorkspaceInvalidationKind");
    expect(mcpServer).toContain("const toolDefinitions = converseToolDefinitions;");
    const mcpToolNames = [...mcpConverseTools.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(mcpToolNames).toEqual(["ask_agent"]);
    expect(`${mcpServer}\n${mcpConverseTools}`).not.toMatch(/workspace[_ -]?events|streamWorkspaceEvents/i);
  });
});
