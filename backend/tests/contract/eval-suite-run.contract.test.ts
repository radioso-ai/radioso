import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

// The test app's eval run service is wired to a stub runner that always returns
// an empty answer, so verdicts here are deterministic: answer_does_not_contain
// passes (empty answer contains nothing), answer_contains fails.

describe("eval suite run contract", () => {
  const captureSnapshot = async (app: import("express").Express, headers: Record<string, string>) => {
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
    return snapshot.body.id as string;
  };

  it("aggregates a pass rate over the workspace and skips cases with no expectations", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "eval-suite-run@example.com");
    const headers = adminSessionHeaders(session);

    const snapshotId = await captureSnapshot(app, headers);

    const passing = await request(app)
      .post("/api/v1/evals/cases")
      .set(headers)
      .send({
        snapshotId,
        name: "Passing case",
        assertions: [{ type: "answer_does_not_contain", pattern: "forbidden", matchMode: "substring" }],
      })
      .expect(201);

    const failing = await request(app)
      .post("/api/v1/evals/cases")
      .set(headers)
      .send({
        snapshotId,
        name: "Failing case",
        assertions: [{ type: "answer_contains", pattern: "refund", matchMode: "substring" }],
      })
      .expect(201);

    const unscored = await request(app)
      .post("/api/v1/evals/cases")
      .set(headers)
      .send({ snapshotId, name: "No expectations case" })
      .expect(201);

    // Before running, the list reports no scored cases passing and no last run.
    const before = await request(app).get("/api/v1/evals/cases").set(headers).expect(200);
    expect(before.body.summary).toMatchObject({ total: 3, scored: 2, passing: 0, unscored: 1 });
    expect(before.body.cases.every((c: { latestRun: unknown }) => c.latestRun === null)).toBe(true);

    const runAll = await request(app)
      .post("/api/v1/evals/cases/run")
      .set(headers)
      .send({})
      .expect(200);

    expect(runAll.body.summary).toMatchObject({
      total: 3,
      scored: 2,
      passing: 1,
      failing: 1,
      unscored: 1,
    });
    const byId = new Map<string, { status: string; run: unknown }>(
      runAll.body.results.map((r: { caseId: string; status: string; run: unknown }) => [r.caseId, r]),
    );
    expect(byId.get(passing.body.id)?.status).toBe("pass");
    expect(byId.get(failing.body.id)?.status).toBe("fail");
    expect(byId.get(unscored.body.id)).toMatchObject({ status: "skipped", run: null });

    // After running, the list's last-run column reflects each case's execution.
    const after = await request(app).get("/api/v1/evals/cases").set(headers).expect(200);
    expect(after.body.summary).toMatchObject({ total: 3, scored: 2, passing: 1, failing: 1 });
    const afterById = new Map<string, { latestRun: { status: string } | null }>(
      after.body.cases.map((c: { id: string; latestRun: { status: string } | null }) => [c.id, c]),
    );
    expect(afterById.get(passing.body.id)?.latestRun?.status).toBe("pass");
    expect(afterById.get(failing.body.id)?.latestRun?.status).toBe("fail");
    expect(afterById.get(unscored.body.id)?.latestRun).toBeNull();
  });

  it("runs only the selected cases while reporting the whole-suite rate", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "eval-suite-run-selected@example.com");
    const headers = adminSessionHeaders(session);

    const snapshotId = await captureSnapshot(app, headers);

    const createCase = async (name: string, pattern: string) =>
      (
        await request(app)
          .post("/api/v1/evals/cases")
          .set(headers)
          .send({
            snapshotId,
            name,
            assertions: [{ type: "answer_does_not_contain", pattern, matchMode: "substring" }],
          })
          .expect(201)
      ).body.id as string;

    const selectedId = await createCase("Selected", "alpha");
    const otherId = await createCase("Other", "beta");

    const run = await request(app)
      .post("/api/v1/evals/cases/run")
      .set(headers)
      .send({ caseIds: [selectedId] })
      .expect(200);

    // Only the selected case ran...
    expect(run.body.results).toHaveLength(1);
    expect(run.body.results[0]).toMatchObject({ caseId: selectedId, status: "pass" });
    // ...but the summary still covers both cases in the workspace.
    expect(run.body.summary).toMatchObject({ total: 2, scored: 2, passing: 1, pending: 1 });

    // The case that was not selected has no run recorded.
    const after = await request(app).get("/api/v1/evals/cases").set(headers).expect(200);
    const afterById = new Map<string, { latestRun: { status: string } | null }>(
      after.body.cases.map((c: { id: string; latestRun: { status: string } | null }) => [c.id, c]),
    );
    expect(afterById.get(selectedId)?.latestRun?.status).toBe("pass");
    expect(afterById.get(otherId)?.latestRun).toBeNull();
  });
});
