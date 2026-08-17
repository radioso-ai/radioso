import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createCrawlerWorkerTaskApp } from "../../src/app/worker/createCrawlerWorkerTaskApp.js";
import { createWorkerTaskApp } from "../../src/app/worker/createWorkerTaskApp.js";
import { WORKER_TASK_AUTH_HEADER } from "../../src/shared/infra/workerTaskAuth.js";
import { createTestDependencies } from "../support/testApp.js";

const taskToken = "0123456789abcdef0123456789abcdef";

const withTaskToken = <T extends { env: object }>(dependencies: T, token: string | undefined): T => {
  Object.assign(dependencies.env, { WORKER_TASK_AUTH_TOKEN: token });
  return dependencies;
};

describe("worker task authentication", () => {
  it.each([
    ["missing", undefined],
    ["malformed", `Bearer ${taskToken}`],
    ["incorrect", "fedcba9876543210fedcba9876543210"],
    ["length-mismatched", "too-short"],
  ])("rejects a %s token before parsing JSON or invoking a worker", async (_label, suppliedToken) => {
    const { dependencies } = createTestDependencies();
    withTaskToken(dependencies, taskToken);
    const runJobById = vi.spyOn(dependencies.documentProcessingWorker, "runJobById");
    const app = createWorkerTaskApp(dependencies);

    const pendingRequest = request(app)
      .post("/internal/tasks/document-processing")
      .set("Content-Type", "application/json")
      .send("{ invalid json");
    if (suppliedToken) {
      pendingRequest.set(WORKER_TASK_AUTH_HEADER, suppliedToken);
    }
    const response = await pendingRequest;

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "unauthorized" });
    expect(runJobById).not.toHaveBeenCalled();
  });

  it("fails closed when the configured worker task token is absent", async () => {
    const { dependencies } = createTestDependencies();
    withTaskToken(dependencies, undefined);
    const runJobById = vi.spyOn(dependencies.documentProcessingWorker, "runJobById");

    const response = await request(createWorkerTaskApp(dependencies))
      .post("/internal/tasks/document-processing")
      .set(WORKER_TASK_AUTH_HEADER, taskToken)
      .send({ jobId: randomUUID() });

    expect(response.status).toBe(401);
    expect(runJobById).not.toHaveBeenCalled();
  });

  it("leaves health public while accepting an exact token on the document worker", async () => {
    const { dependencies } = createTestDependencies();
    withTaskToken(dependencies, taskToken);
    const runJobById = vi.spyOn(dependencies.documentProcessingWorker, "runJobById").mockResolvedValue("processed");
    const app = createWorkerTaskApp(dependencies);

    await request(app).get("/health").expect(200, { status: "ok" });

    const jobId = randomUUID();
    await request(app)
      .post("/internal/tasks/document-processing")
      .set(WORKER_TASK_AUTH_HEADER, taskToken)
      .send({ jobId })
      .expect(204);

    expect(runJobById).toHaveBeenCalledWith(jobId);
  });

  it("guards action, recovery, and legacy task routes on the document worker", async () => {
    const { dependencies } = createTestDependencies();
    withTaskToken(dependencies, taskToken);
    const documentRunOnce = vi.spyOn(dependencies.documentProcessingWorker, "runOnce");
    const actionDrain = vi.spyOn(dependencies.actionDispatchWorker, "drain");
    const app = createWorkerTaskApp(dependencies);

    for (const path of [
      "/internal/tasks/document-processing/recover",
      "/internal/tasks/actions/drain",
      "/internal/tasks/actions/recover",
      "/internal/tasks/website-crawl",
    ]) {
      await request(app).post(path).send({}).expect(401, { error: "unauthorized" });
    }

    expect(documentRunOnce).not.toHaveBeenCalled();
    expect(actionDrain).not.toHaveBeenCalled();
  });

  it("guards crawler task and recovery routes while leaving crawler health public", async () => {
    const { dependencies } = createTestDependencies();
    withTaskToken(dependencies, taskToken);
    const runJobById = vi.spyOn(dependencies.websiteCrawlWorker, "runJobById");
    const runOnce = vi.spyOn(dependencies.websiteCrawlWorker, "runOnce");
    const app = createCrawlerWorkerTaskApp(dependencies);

    await request(app).get("/health").expect(200, { status: "ok" });
    await request(app).post("/internal/tasks/website-crawl").send({ jobId: randomUUID() }).expect(401, { error: "unauthorized" });
    await request(app).post("/internal/tasks/website-crawl/recover").send({}).expect(401, { error: "unauthorized" });

    expect(runJobById).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("accepts an exact token on the crawler worker", async () => {
    const { dependencies } = createTestDependencies();
    withTaskToken(dependencies, taskToken);
    const runJobById = vi.spyOn(dependencies.websiteCrawlWorker, "runJobById").mockResolvedValue("processed");
    const app = createCrawlerWorkerTaskApp(dependencies);
    const jobId = randomUUID();

    await request(app)
      .post("/internal/tasks/website-crawl")
      .set(WORKER_TASK_AUTH_HEADER, taskToken)
      .send({ jobId })
      .expect(204);

    expect(runJobById).toHaveBeenCalledWith(jobId);
  });
});
