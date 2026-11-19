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
      required: expect.arrayContaining(["messageId", "occurrenceCount"]),
      properties: {
        messageId: { type: "string", format: "uuid" },
        occurrenceCount: { type: "integer", minimum: 1 },
      },
    });

    expect(document.components?.schemas?.AudiencePulseTheme).toMatchObject({
      required: expect.arrayContaining(["distinctQuestionCount"]),
      properties: { distinctQuestionCount: { type: "integer", minimum: 0 } },
    });
    expect(document.components?.schemas?.AudiencePulseReport).toMatchObject({
      required: expect.arrayContaining([
        "narrativeGeneratedAt",
        "narrativeReuseCount",
        "narrativeReuseMaxDrift",
        "isFirstCensus",
        "unclassifiedQuestionCount",
        "dissolvedTopics",
      ]),
      properties: {
        narrativeGeneratedAt: { type: "string", format: "date-time" },
        narrativeReuseCount: { type: "integer", minimum: 0 },
        narrativeReuseMaxDrift: { type: "number", minimum: 0, maximum: 1 },
        isFirstCensus: { type: "boolean" },
        unclassifiedQuestionCount: { type: "integer", minimum: 0 },
        dissolvedTopics: {
          type: "array",
          items: { $ref: "#/components/schemas/AudiencePulseDissolvedTopic" },
        },
      },
    });
    expect(document.components?.schemas?.AudiencePulseDissolvedTopic).toMatchObject({
      type: "object",
      required: ["id", "title"],
      properties: { id: { type: "string" }, title: { type: "string" } },
    });
    expect(document.components?.schemas?.AudiencePulseTopicTransition).toMatchObject({
      required: expect.arrayContaining(["membershipOverlap"]),
      properties: {
        membershipOverlap: {
          anyOf: expect.arrayContaining([
            { type: "number", minimum: 0, maximum: 1 },
            { type: "null" },
          ]),
        },
      },
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

  it("publishes the session-only topic dismissal and draft-link endpoints", () => {
    const document = createOpenApiDocument();
    const dismissal = document.paths?.["/api/v1/quality/audience-pulse/topics/{topicId}/dismissal"];
    const drafts = document.paths?.["/api/v1/quality/audience-pulse/topics/{topicId}/drafts"];

    expect(dismissal?.put?.operationId).toBe("dismissAudiencePulseTopic");
    expect(dismissal?.delete?.operationId).toBe("restoreAudiencePulseTopic");
    expect(drafts?.post?.operationId).toBe("linkAudiencePulseTopicDraft");
    for (const operation of [dismissal?.put, dismissal?.delete, drafts?.post]) {
      expect(operation?.security).toEqual([{ sessionCookie: [], workspaceSelection: [] }]);
      expect(operation?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "topicId", in: "path", required: true }),
      ]));
      for (const status of ["204", "400", "401", "403", "404"]) {
        expect(operation?.responses).toHaveProperty(status);
      }
    }
    expect(drafts?.post?.requestBody).toMatchObject({ required: true });
    expect(document.components?.schemas?.AudiencePulseTopicDraftLinkRequest).toMatchObject({
      type: "object",
      required: ["documentId"],
      properties: { documentId: { type: "string", format: "uuid" } },
    });
  });

  it("publishes each content gap's operator state and the report's whole-window counts", () => {
    const schemas = createOpenApiDocument().components?.schemas;

    expect(schemas?.AudiencePulseContentGap).toMatchObject({
      required: expect.arrayContaining(["dismissedAt", "latestDraft"]),
      properties: {
        dismissedAt: { anyOf: expect.arrayContaining([{ type: "string", format: "date-time" }, { type: "null" }]) },
        latestDraft: {
          anyOf: expect.arrayContaining([{ $ref: "#/components/schemas/AudiencePulseTopicDraft" }, { type: "null" }]),
        },
      },
    });
    const report = schemas?.AudiencePulseReport as { required?: string[]; properties?: Record<string, unknown> };
    for (const field of ["totals", "dailyVolume", "previousPeriod", "channels", "previousGeneratedAt"]) {
      expect(report.properties).toHaveProperty(field);
      expect(report.required).not.toContain(field);
    }
    expect(schemas?.AudiencePulseReportTotals).toMatchObject({
      required: expect.arrayContaining(["questionCount", "conversationCount", "answers", "contentGapEligibleCount", "unclassified"]),
    });
    expect(schemas?.AudiencePulseDailyVolume).toMatchObject({
      required: expect.arrayContaining(["day", "questionCount", "conversationCount", "answeredCount", "contentGapEligibleCount"]),
      properties: { day: { type: "string", format: "date" } },
    });
    expect(schemas?.AudiencePulseChannelVolume).toMatchObject({
      required: expect.arrayContaining(["channel", "questionCount", "answeredCount", "contentGapEligibleCount"]),
    });
    expect(schemas?.AudiencePulsePreviousPeriod).toMatchObject({
      required: expect.arrayContaining(["period", "questionCount", "conversationCount", "answeredCount", "contentGapEligibleCount"]),
    });
  });
});
