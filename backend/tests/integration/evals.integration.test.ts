import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestToken } from "../support/testApp.js";

describe("eval regression lab", () => {
  it("imports a chat turn into a dataset and runs replay with comparison", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "evals@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Session Cookie",
        content: "Browser sessions use an HTTP-only cookie named radioso_session.",
      })
      .expect(202);

    const chatResponse = await request(app)
      .post("/api/v1/chat/")
      .set("Authorization", authorization)
      .send({
        query: "Which cookie name is used for browser sessions?",
        stream: false,
      })
      .expect(200);

    const conversationId = chatResponse.body.conversationId as string;
    const historyResponse = await request(app)
      .get(`/api/v1/chat/history/${conversationId}`)
      .set("Authorization", authorization)
      .expect(200);

    const assistantMessage = historyResponse.body.messages.find((message: { role: string }) => message.role === "assistant");
    expect(assistantMessage?.id).toBeTruthy();

    const datasetResponse = await request(app)
      .post("/api/v1/evals/datasets")
      .set("Authorization", authorization)
      .send({
        name: "Regression guards",
        description: "Imported chat regressions",
      })
      .expect(201);

    const datasetId = datasetResponse.body.id as string;
    expect(datasetResponse.body.caseCount).toBe(0);
    expect(datasetResponse.body.runCount).toBe(0);
    expect(datasetResponse.body.lastRunAt).toBeNull();

    const importResponse = await request(app)
      .post("/api/v1/evals/import/chat-history")
      .set("Authorization", authorization)
      .send({
        conversationId,
        assistantMessageId: assistantMessage.id,
      })
      .expect(200);

    expect(importResponse.body.importDraft.query).toContain("cookie name");
    expect(importResponse.body.importDraft.seededExpectations.expectedCitationTitles).toContain("Session Cookie");

    const caseResponse = await request(app)
      .post(`/api/v1/evals/datasets/${datasetId}/cases`)
      .set("Authorization", authorization)
      .send({
        title: importResponse.body.importDraft.title,
        query: importResponse.body.importDraft.query,
        conversationContext: importResponse.body.importDraft.conversationContext,
        sourceType: importResponse.body.importDraft.sourceType,
        provenance: importResponse.body.importDraft.provenance,
        expectations: importResponse.body.importDraft.seededExpectations,
      })
      .expect(201);

    expect(caseResponse.body.datasetId).toBe(datasetId);
    expect(caseResponse.body.sourceType).toBe("conversation_import");

    const firstRun = await request(app)
      .post(`/api/v1/evals/datasets/${datasetId}/runs`)
      .set("Authorization", authorization)
      .send({ label: "baseline" })
      .expect(201);

    expect(firstRun.body.summary.totalCases).toBe(1);
    expect(firstRun.body.summary.passCount).toBe(1);

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        answerSupportPolicy: "strict",
        rerankEnabled: false,
        vectorTopK: 1,
        similarityThreshold: 0.99,
        rerankTopK: 1,
        citationDisplayEnabled: false,
        metadataRules: [],
        customInstruction: "",
      })
      .expect(200);

    const secondRun = await request(app)
      .post(`/api/v1/evals/datasets/${datasetId}/runs`)
      .set("Authorization", authorization)
      .send({ label: "candidate", baselineRunId: firstRun.body.id })
      .expect(201);

    expect(secondRun.body.summary.totalCases).toBe(1);
    expect(secondRun.body.summary.failCount).toBe(1);
    expect(secondRun.body.summary.regressionCount).toBe(1);

    const comparison = await request(app)
      .get(`/api/v1/evals/datasets/${datasetId}/runs/${secondRun.body.id}/comparison`)
      .set("Authorization", authorization)
      .query({ baselineRunId: firstRun.body.id })
      .expect(200);

    expect(comparison.body.regressions).toBe(1);
    expect(comparison.body.cases[0].outcome).toBe("regressed");
  });
});
