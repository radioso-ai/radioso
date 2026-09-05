import request from "supertest";
import { describe, expect, it } from "vitest";

import { formatIsoDateUtc } from "../../src/shared/domain/clock.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const isoDateFromToday = (offsetDays: number): string =>
  formatIsoDateUtc(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));

describe("retrieval answer integration", () => {
  it("answers from retrieval without creating assistant conversation history", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-answer-integration@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .post("/api/v1/document/")
      .set(headers)
      .send({
        title: "Course Calendar",
        content: "The advanced workshop runs next month for returning students.",
      })
      .expect(202);

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(headers)
      .send({
        query: "When does the advanced workshop run?",
        includeDebug: true,
      })
      .expect(200);

    expect(response.body).toMatchObject({
      outcome: "answer",
      answer: expect.any(String),
      debug: {
        activitySummary: {
          execution: {
            surface: "retrieval",
            path: "retrieval_answer",
            retrievalInvoked: true,
          },
        },
        activityTrace: {
          summary: {
            execution: {
              surface: "retrieval",
              path: "retrieval_answer",
              retrievalInvoked: true,
            },
          },
        },
      },
    });
    expect(response.body).not.toHaveProperty("conversationId");

    const history = await request(app)
      .get("/api/v1/history/chat")
      .set(headers)
      .expect(200);
    expect(history.body.conversations).toEqual([]);
  });

  it("attempts retrieval for conversational requests instead of rejecting them", async () => {
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: input.query,
            semanticQuery: input.query,
            lexicalQuery: input.query,
            turnKind: "fresh_subject",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.96,
          };
        },
      },
    });
    const session = await issueTestSession(app, "retrieval-answer-conversational-integration@example.com");
    const headers = adminSessionHeaders(session);

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(headers)
      .send({ query: "thanks for the help" })
      .expect(200);

    // The retrieval-answer API is a pure retrieval surface: it no longer
    // classifies turn intent, so a conversational query is attempted as a
    // retrieval query (yielding a grounded answer) rather than returned as a
    // separate "unsupported" outcome.
    expect(response.body.outcome).toBe("answer");
    expect(response.body).not.toHaveProperty("code");
  });

  it("marks MCP capability diagnostics separately from direct retrieval answer clients", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "retrieval-answer-mcp-integration@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .post("/api/v1/document/")
      .set(headers)
      .send({
        title: "Course Calendar",
        content: "The advanced workshop runs next month for returning students.",
      })
      .expect(202);

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(headers)
      .set("x-radioso-capability-client", "mcp")
      .send({
        query: "When does the advanced workshop run?",
        includeDebug: true,
      })
      .expect(200);

    expect(response.body.debug.activitySummary.execution).toMatchObject({
      surface: "mcp_capability",
      path: "mcp_grounded_answer",
      retrievalInvoked: true,
    });
    expect(response.body.debug.activityTrace.summary.execution).toMatchObject({
      surface: "mcp_capability",
      path: "mcp_grounded_answer",
      retrievalInvoked: true,
    });
  });

  it("answers a named event date from dated retrieved evidence", async () => {
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: `${input.query} August 10 2026`,
            semanticQuery: "Summer Workshop August 10 2026",
            lexicalQuery: "Summer Workshop August 10 2026",
            queryShape: "event_date_lookup",
            temporalQueryMode: "topic_refinement",
            turnKind: "fresh_subject",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.96,
          };
        },
      },
    });
    const session = await issueTestSession(app, "retrieval-answer-event-date@example.com");
    const headers = adminSessionHeaders(session);

    await request(app)
      .post("/api/v1/document/")
      .set(headers)
      .send({
        title: "Summer Workshop",
        content: [
          "Summer Workshop introduces advanced practice for returning students.",
          "Registration instructions appear in the final section.",
          "The Summer Workshop takes place on August 10, 2026.",
        ].join("\n\n"),
        metadata: {
          dateFrom: "2026-08-10",
          dateTo: "2026-08-10",
          sourceUrl: "https://events.example/summer-workshop",
        },
      })
      .expect(202);

    const response = await request(app)
      .post("/api/v1/retrieval/answer")
      .set(headers)
      .send({
        query: "When does the Summer Workshop take place?",
        includeDebug: true,
      })
      .expect(200);

    expect(response.body.outcome).toBe("answer");
    expect(response.body.answer).toEqual(expect.any(String));
    // Deterministic assertion boundary (spec Testing Strategy): retrieval must
    // surface the dated evidence, including the chunk that states the date in a
    // different paragraph than the event introduction. Answer phrasing is the
    // live LLM's job and is covered by the workbench eval cases.
    expect(response.body.debug.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Summer Workshop",
          metadata: expect.objectContaining({
            dateFrom: "2026-08-10",
            dateTo: "2026-08-10",
          }),
        }),
      ]),
    );
    const evidenceContents = (response.body.debug.evidence as Array<{ content: string }>).map(
      (entry) => entry.content,
    );
    expect(evidenceContents.some((content) => content.includes("August 10, 2026"))).toBe(true);
  });

  it("returns deterministic evidence order across repeated actuality-sort retrieval answers", async () => {
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: `${input.query} event schedule`,
            semanticQuery: "event schedule",
            lexicalQuery: "event schedule",
            queryShape: "event_date_lookup",
            temporalQueryMode: "listing",
            turnKind: "fresh_subject",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.96,
          };
        },
      },
      rerankGateway: {
        async rerank(input) {
          // Deliberately anti-correlated with the expected temporal order: the past
          // event scores highest and the later upcoming event outscores the sooner
          // one, so the asserted order can only come from the temporal sort.
          const order = new Map([
            ["Morning Retreat", 0.98],
            ["Autumn Intensive", 0.97],
            ["Summer Workshop", 0.96],
          ]);
          return input.contexts.map((context) => ({
            chunkId: context.chunkId,
            relevanceScore: order.get(context.title) ?? 0.1,
          }));
        },
      },
    });
    const session = await issueTestSession(app, "retrieval-answer-actuality-sort@example.com");
    const headers = adminSessionHeaders(session);

    // Fixture dates are relative to the wall clock (the pipeline sorts against the
    // system clock, which createTestApp cannot freeze), so the test cannot rot when
    // real time passes a fixed date. ±30-day offsets stay clear of UTC-midnight races.
    const laterUpcomingDate = isoDateFromToday(60);
    const soonerUpcomingDate = isoDateFromToday(30);
    const pastDate = isoDateFromToday(-30);
    for (const event of [
      { title: "Autumn Intensive", date: laterUpcomingDate, content: `Event schedule: Autumn Intensive happens on ${laterUpcomingDate}.` },
      { title: "Summer Workshop", date: soonerUpcomingDate, content: `Event schedule: Summer Workshop happens on ${soonerUpcomingDate}.` },
      { title: "Morning Retreat", date: pastDate, content: `Event schedule: Morning Retreat happens on ${pastDate}.` },
    ]) {
      await request(app)
        .post("/api/v1/document/")
        .set(headers)
        .send({
          title: event.title,
          content: event.content,
          metadata: { dateFrom: event.date, dateTo: event.date },
        })
        .expect(202);
    }

    const observedOrders: string[][] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(app)
        .post("/api/v1/retrieval/answer")
        .set(headers)
        .send({
          query: "Sort events by actuality.",
          includeDebug: true,
        })
        .expect(200);

      observedOrders.push((response.body.debug.evidence as Array<{ title: string }>).map((entry) => entry.title));
      expect(response.body.debug.activitySummary.temporalDeterministicSort).toMatchObject({
        enabled: true,
      });
    }

    // Upcoming events lead soonest-first and the past event is demoted to the
    // bottom despite winning the rerank stub (0.98) — the #910 temporal ordering
    // contract overrides rerank order for dated contexts.
    expect(observedOrders).toEqual([
      ["Summer Workshop", "Autumn Intensive", "Morning Retreat"],
      ["Summer Workshop", "Autumn Intensive", "Morning Retreat"],
      ["Summer Workshop", "Autumn Intensive", "Morning Retreat"],
    ]);
  });
});
