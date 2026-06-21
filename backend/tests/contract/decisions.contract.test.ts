import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";

describe("decisions contract", () => {
  it("advertises the pending approval decision list", () => {
    const document = createOpenApiDocument();
    const operation = document.paths?.["/api/v1/decisions"]?.get;

    expect(operation).toMatchObject({
      operationId: "listPendingDecisions",
      tags: ["Decisions"],
      security: [{ bearerAuth: [] }],
    });
    expect(operation?.responses).toMatchObject({
      200: expect.objectContaining({
        content: {
          "application/json": {
            schema: expect.objectContaining({
              $ref: "#/components/schemas/PendingApprovalDecisionListResponse",
            }),
          },
        },
      }),
      401: expect.any(Object),
      403: expect.any(Object),
    });
    expect(document.components?.schemas?.PendingApprovalDecisionListResponse).toMatchObject({
      properties: expect.objectContaining({
        decisions: expect.any(Object),
      }),
      required: expect.arrayContaining(["decisions"]),
    });
    const decisionSchema = document.components?.schemas?.PendingApprovalDecision;
    expect(decisionSchema).toMatchObject({
      properties: expect.objectContaining({
        handle: expect.any(Object),
        conversationId: expect.any(Object),
        agentId: expect.any(Object),
        routineId: expect.any(Object),
        stepId: expect.any(Object),
        reason: expect.any(Object),
        options: expect.any(Object),
        contentHash: expect.any(Object),
        deadline: expect.any(Object),
        createdAt: expect.any(Object),
      }),
      required: expect.arrayContaining([
        "handle",
        "conversationId",
        "agentId",
        "routineId",
        "stepId",
        "reason",
        "options",
        "contentHash",
        "deadline",
        "createdAt",
      ]),
    });
  });

  it("advertises the approval decision resolve command", () => {
    const document = createOpenApiDocument();
    const operation = document.paths?.["/api/v1/agents/{agentId}/decisions/{handle}/resolve"]?.post;

    expect(operation).toMatchObject({
      operationId: "resolveDecision",
      tags: ["Agents"],
      security: [{ bearerAuth: [] }],
    });
    expect(operation?.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: expect.objectContaining({
            properties: expect.objectContaining({
              optionId: expect.any(Object),
              payload: expect.any(Object),
              contentHash: expect.any(Object),
            }),
            required: expect.arrayContaining(["optionId", "contentHash"]),
          }),
        },
      },
    });
    expect(operation?.responses).toMatchObject({
      200: expect.objectContaining({ description: expect.any(String) }),
      400: expect.any(Object),
      401: expect.any(Object),
      403: expect.any(Object),
      404: expect.any(Object),
      409: expect.any(Object),
      422: expect.any(Object),
    });
  });
});
