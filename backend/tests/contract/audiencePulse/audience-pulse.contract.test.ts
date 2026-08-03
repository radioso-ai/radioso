import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../../../src/app/http/openapi/openApiDocument.js";

describe("Audience Pulse OpenAPI contract", () => {
  it("publishes the session-only saved-read and explicit-refresh endpoints", () => {
    const document = createOpenApiDocument();
    const path = document.paths?.["/api/v1/quality/audience-pulse"];
    const anchorPath = document.paths?.["/api/v1/quality/audience-pulse/evidence-anchor"];

    expect(path?.get?.operationId).toBe("getAudiencePulse");
    expect(path?.post?.operationId).toBe("refreshAudiencePulse");
    expect(path?.get?.security).toEqual([{ sessionCookie: [], workspaceSelection: [] }]);
    expect(path?.post?.security).toEqual([{ sessionCookie: [], workspaceSelection: [] }]);
    expect(path?.get?.responses).toHaveProperty("200");
    expect(path?.get?.responses).toHaveProperty("401");
    expect(path?.get?.responses).toHaveProperty("403");
    expect(path?.post?.responses).toHaveProperty("200");
    expect(path?.post?.responses).toHaveProperty("401");
    expect(path?.post?.responses).toHaveProperty("403");
    expect(path?.post?.responses).toHaveProperty("409");
    expect(path?.post?.responses).toHaveProperty("429");
    expect(path?.post?.responses).toHaveProperty("503");

    const evidence = document.components?.schemas?.AudiencePulseEvidence;
    expect(evidence).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["messageId"]),
      properties: { messageId: { type: "string", format: "uuid" } },
    });

    expect(anchorPath?.post?.operationId).toBe("getAudiencePulseEvidenceAnchor");
    expect(anchorPath?.post?.security).toEqual([{ sessionCookie: [], workspaceSelection: [] }]);
    expect(anchorPath?.post?.requestBody).toMatchObject({ required: true });
    expect(anchorPath?.post?.responses).toHaveProperty("200");
    expect(anchorPath?.post?.responses).toHaveProperty("400");
    expect(anchorPath?.post?.responses).toHaveProperty("401");
    expect(anchorPath?.post?.responses).toHaveProperty("403");
    expect(anchorPath?.post?.responses).toHaveProperty("404");

    expect(document.components?.schemas?.AudiencePulseEvidenceAnchorRequest).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["conversationId", "messageId"]),
      properties: {
        conversationId: { type: "string", format: "uuid" },
        messageId: { type: "string", format: "uuid" },
      },
    });
    expect(document.components?.schemas?.AudiencePulseEvidenceAnchorResponse).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["conversationId", "source", "nextAssistant"]),
      properties: {
        nextAssistant: {
          anyOf: expect.arrayContaining([
            { $ref: "#/components/schemas/AudiencePulseEvidenceAnchorNextAssistant" },
            { type: "null" },
          ]),
        },
      },
    });
  });
});
