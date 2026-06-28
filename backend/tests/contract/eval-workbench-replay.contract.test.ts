import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { WORKBENCH_REPLAY_RATE_LIMIT } from "../../src/modules/eval/routes/workbenchReplayRateLimit.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const countMessages = (items: Map<string, unknown[]>): number =>
  [...items.values()].reduce((total, messages) => total + messages.length, 0);

describe("eval Workbench replay contract", () => {
  it("deletes an eval case through the workspace-scoped API", async () => {
    const chatGateway: ChatGateway = {
      async answer({ query }) {
        return `captured:${query}`;
      },
      async *streamAnswer({ query }) {
        yield `captured:${query}`;
      },
    };
    const { app, repositories } = createTestApp({ chatGateway });
    const session = await issueTestSession(app, "eval-case-delete@example.com");
    const headers = adminSessionHeaders(session);

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set(headers)
      .send({ message: "What is the refund policy?", stream: false })
      .expect(200);

    const snapshot = await request(app)
      .post("/api/v1/evals/snapshots")
      .set(headers)
      .send({ conversationId: chat.body.conversationId })
      .expect(201);

    const created = await request(app)
      .post("/api/v1/evals/cases")
      .set(headers)
      .send({ snapshotId: snapshot.body.id, name: "Delete from eval" })
      .expect(201);

    await request(app)
      .delete(`/api/v1/evals/cases/${created.body.id}`)
      .set(headers)
      .expect(204);

    expect(repositories.auditEventRepository.items).toContainEqual(
      expect.objectContaining({
        workspaceId: session.workspaceId,
        eventType: "eval.case.delete",
        eventStatus: "success",
        metadata: { caseId: created.body.id },
      }),
    );

    const deleted = await request(app)
      .get(`/api/v1/evals/cases/${created.body.id}`)
      .set(headers)
      .expect(404);
    expect(deleted.body.error).toMatchObject({
      code: "not_found",
      message: "Eval case not found",
    });
  });

  it("runs a one-off full assistant replay with an agent config override and does not persist chat messages", async () => {
    const chatGateway: ChatGateway = {
      async answer({ query }) {
        return `captured:${query}`;
      },
      async *streamAnswer({ query }) {
        yield `captured:${query}`;
      },
    };
    const { app, repositories } = createTestApp({
      chatGateway,
      workbenchReplayRunner: {
        async run(input) {
          const retrievalSettings = input.agentConfigOverride?.skillSettings?.["retrieval.answer"] as
            | { settings?: { vectorTopK?: number } }
            | undefined;
          return {
            answer: `${input.agentConfigOverride?.customInstruction} vectorTopK=${retrievalSettings?.settings?.vectorTopK}`,
            citations: [{ documentId: "doc-refund", chunkId: "chunk-refund", title: "Refund Policy" }],
            answerSegments: [
              {
                text: "Replay answer",
                citationIndices: [0],
              },
            ],
            turnTrace: {
              version: 1,
              spine: {
                traceId: "trace-workbench-replay",
                startedAt: new Date(0).toISOString(),
                stages: [],
              },
            },
            resolvedConfig: {
              composedInstructions: "resolved replay instructions",
              modelProvider: "openai",
              modelId: "gpt-5-mini",
              retrievedChunks: [
                { chunkId: "chunk-refund", documentId: "doc-refund", title: "Refund Policy", rank: 0 },
              ],
            },
          };
        },
      },
    });
    const session = await issueTestSession(app, "eval-workbench-replay@example.com");
    const headers = adminSessionHeaders(session);

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set(headers)
      .send({ message: "What is the refund policy?", stream: false })
      .expect(200);

    const snapshot = await request(app)
      .post("/api/v1/evals/snapshots")
      .set(headers)
      .send({ conversationId: chat.body.conversationId })
      .expect(201);

    const messagesBeforeReplay = countMessages(repositories.messageRepository.items);

    const replay = await request(app)
      .post("/api/v1/evals/runs")
      .set(headers)
      .send({
        snapshotId: snapshot.body.id,
        mode: "full_assistant",
        agentConfigOverride: {
          customInstruction: "Use the Workbench override.",
          skillSettings: {
            "retrieval.answer": {
              settings: {
                vectorTopK: 7,
              },
            },
          },
        },
      })
      .expect(201);

    expect(replay.body).toMatchObject({
      answer: "Use the Workbench override. vectorTopK=7",
      citations: [{ documentId: "doc-refund", chunkId: "chunk-refund", title: "Refund Policy" }],
      answerSegments: [{ text: "Replay answer", citationIndices: [0] }],
      turnTrace: {
        version: 1,
        spine: { traceId: "trace-workbench-replay" },
      },
      resolvedConfig: {
        composedInstructions: "resolved replay instructions",
        modelProvider: "openai",
        modelId: "gpt-5-mini",
        retrievedChunks: [
          { chunkId: "chunk-refund", documentId: "doc-refund", title: "Refund Policy", rank: 0 },
        ],
      },
      run: {
        observedOutput: {
          answer: "Use the Workbench override. vectorTopK=7",
          turnTrace: {
            version: 1,
            spine: { traceId: "trace-workbench-replay" },
          },
        },
      },
    });
    expect(replay.body.run.overrides.agentConfigOverride).toMatchObject({
      customInstruction: "Use the Workbench override.",
    });
    expect(countMessages(repositories.messageRepository.items)).toBe(messagesBeforeReplay);
  });

  it("routes a routine-only override through the Workbench replay path", async () => {
    const { app } = createTestApp({
      workbenchReplayRunner: {
        async run(input) {
          return {
            answer: `routine:${input.routineStartState?.routineId ?? "none"}`,
            citations: [],
            answerSegments: [],
            turnTrace: {
              version: 1,
              spine: { traceId: "trace-routine-replay", startedAt: new Date(0).toISOString(), stages: [] },
            },
            resolvedConfig: {
              composedInstructions: "resolved replay instructions",
              modelProvider: "openai",
              modelId: "gpt-5-mini",
              retrievedChunks: [],
            },
          };
        },
      },
    });
    const session = await issueTestSession(app, "eval-routine-only-replay@example.com");
    const headers = adminSessionHeaders(session);

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set(headers)
      .send({ message: "How does yearly billing save?", stream: false })
      .expect(200);
    const snapshot = await request(app)
      .post("/api/v1/evals/snapshots")
      .set(headers)
      .send({ conversationId: chat.body.conversationId })
      .expect(201);

    const replay = await request(app)
      .post("/api/v1/evals/runs")
      .set(headers)
      .send({
        snapshotId: snapshot.body.id,
        mode: "full_assistant",
        overrides: {
          routineStartState: {
            routineId: "ask_email_on_interest",
            path: ["step_1_ask"],
            variables: { customer_email: "buyer@example.com" },
            status: "active",
          },
        },
      })
      .expect(201);

    // A routine-only override must hit the replay path, not the plain retrieval runner.
    expect(replay.body.answer).toBe("routine:ask_email_on_interest");
    expect(replay.body.run.overrides.routineStartState).toMatchObject({
      routineId: "ask_email_on_interest",
      path: ["step_1_ask"],
    });
  });

  it("rejects a routine replay seed without a resume step", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "eval-routine-empty-path@example.com");

    const response = await request(app)
      .post("/api/v1/evals/runs")
      .set(adminSessionHeaders(session))
      .send({
        snapshotId: "11111111-1111-4111-8111-111111111111",
        mode: "full_assistant",
        overrides: {
          routineStartState: {
            routineId: "ask_email_on_interest",
            path: [],
            variables: {},
            status: "active",
          },
        },
      })
      .expect(400);

    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid request body",
    });
    expect(JSON.stringify(response.body.error.details)).toContain("Array must contain at least 1 element");
  });

  it("rejects unknown top-level agent config override fields", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "eval-workbench-replay-validation@example.com");

    const response = await request(app)
      .post("/api/v1/evals/runs")
      .set(adminSessionHeaders(session))
      .send({
        snapshotId: "11111111-1111-4111-8111-111111111111",
        mode: "full_assistant",
        agentConfigOverride: {
          customInstruction: "Allowed",
          mysteryField: "rejected",
        },
      })
      .expect(400);

    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid request body",
    });
    expect(JSON.stringify(response.body.error.details)).toContain("mysteryField");
  });

  it("rate limits Workbench replay runs per workspace", async () => {
    const { app } = createTestApp({
      workbenchReplayRunner: {
        async run() {
          return {
            answer: "Replay answer.",
            citations: [],
            answerSegments: [],
            turnTrace: {
              version: 1,
              spine: {
                traceId: "trace-workbench-replay",
                startedAt: new Date(0).toISOString(),
                stages: [],
              },
            },
            resolvedConfig: {
              composedInstructions: "resolved replay instructions",
              modelProvider: "openai",
              modelId: "gpt-5-mini",
              retrievedChunks: [],
            },
          };
        },
      },
    });
    const session = await issueTestSession(app, "eval-workbench-rate-limit@example.com");
    const headers = adminSessionHeaders(session);

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set(headers)
      .send({ message: "What is the refund policy?", stream: false })
      .expect(200);
    const snapshot = await request(app)
      .post("/api/v1/evals/snapshots")
      .set(headers)
      .send({ conversationId: chat.body.conversationId })
      .expect(201);

    const body = {
      snapshotId: snapshot.body.id,
      mode: "full_assistant",
      agentConfigOverride: {
        customInstruction: "Use a replay override.",
      },
    };

    for (let i = 0; i < WORKBENCH_REPLAY_RATE_LIMIT.limit; i += 1) {
      await request(app)
        .post("/api/v1/evals/runs")
        .set(headers)
        .send(body)
        .expect(201);
    }

    const blocked = await request(app)
      .post("/api/v1/evals/runs")
      .set(headers)
      .send(body)
      .expect(429);

    expect(blocked.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      details: expect.objectContaining({
        retryAfterSeconds: expect.any(Number),
      }),
    });
  });

  it("rate limits case-scoped Workbench replay runs per workspace", async () => {
    const { app } = createTestApp({
      workbenchReplayRunner: {
        async run() {
          return {
            answer: "Replay answer.",
            citations: [],
            answerSegments: [],
            turnTrace: {
              version: 1,
              spine: {
                traceId: "trace-workbench-replay",
                startedAt: new Date(0).toISOString(),
                stages: [],
              },
            },
            resolvedConfig: {
              composedInstructions: "resolved replay instructions",
              modelProvider: "openai",
              modelId: "gpt-5-mini",
              retrievedChunks: [],
            },
          };
        },
      },
    });
    const session = await issueTestSession(app, "eval-workbench-case-rate-limit@example.com");
    const headers = adminSessionHeaders(session);

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set(headers)
      .send({ message: "What is the refund policy?", stream: false })
      .expect(200);
    const snapshot = await request(app)
      .post("/api/v1/evals/snapshots")
      .set(headers)
      .send({ conversationId: chat.body.conversationId })
      .expect(201);
    const evalCase = await request(app)
      .post("/api/v1/evals/cases")
      .set(headers)
      .send({ snapshotId: snapshot.body.id, name: "Case-scoped replay limit" })
      .expect(201);

    const body = {
      mode: "full_assistant",
      overrides: {
        agentConfigOverride: {
          customInstruction: "Use a replay override.",
        },
      },
    };

    for (let i = 0; i < WORKBENCH_REPLAY_RATE_LIMIT.limit; i += 1) {
      await request(app)
        .post(`/api/v1/evals/cases/${evalCase.body.id}/runs`)
        .set(headers)
        .send(body)
        .expect(201);
    }

    const blocked = await request(app)
      .post(`/api/v1/evals/cases/${evalCase.body.id}/runs`)
      .set(headers)
      .send(body)
      .expect(429);

    expect(blocked.body.error).toMatchObject({
      code: "rate_limit_exceeded",
      details: expect.objectContaining({
        retryAfterSeconds: expect.any(Number),
      }),
    });
  });
});
