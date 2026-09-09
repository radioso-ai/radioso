import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { describe, expect, it } from "vitest";

import { createOpenApiRegistry } from "../../src/app/http/openapi/openApiRegistry.js";
import { registerTestExecutionPaths } from "../../src/app/http/openapi/paths/testExecutionPaths.js";

describe("test execution OpenAPI contract", () => {
  it("documents private fenced start, retain-one-side, message, and failed-side retry operations", () => {
    const { registry, security } = createOpenApiRegistry();
    registerTestExecutionPaths(registry, security);
    const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi: "3.1.0", info: { title: "test", version: "1" } });
    const start = document.paths?.["/api/v1/agents/{agentId}/test-executions"]?.post;
    const message = document.paths?.["/api/v1/agents/{agentId}/test-executions/{executionId}/messages"]?.post;
    const retain = document.paths?.["/api/v1/agents/{agentId}/test-executions/{executionId}/sides/{sideId}/retain"]?.post;
    const retry = document.paths?.["/api/v1/agents/{agentId}/test-executions/{executionId}/sides/{sideId}/retry"]?.post;
    expect(start?.operationId).toBe("startAgentTestExecution");
    expect(message?.requestBody).toBeDefined();
    expect(retain?.operationId).toBe("retainAgentTestExecutionSide");
    expect(retain?.responses?.["201"]?.content?.["application/json"]?.schema).toBeDefined();
    expect(retry?.responses?.["200"]?.content?.["text/event-stream"]?.schema).toBeDefined();
    expect(document.components?.schemas?.TestExecutionEvent).toMatchObject({ oneOf: expect.any(Array) });
  });
});
