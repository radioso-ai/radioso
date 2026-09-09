import { Router, type Response } from "express";
import { z } from "zod";

import type { TestExecutionService, TestExecution, TestExecutionAttemptRecord, TestExecutionEvent, TestExecutionHistoryItem } from "../../../modules/test-execution/testExecution.js";
import type { WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspaceSession } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import { presentRevisionSummary } from "./agentRevisionPresenters.js";
import { retryTestExecutionSideSchema, sendTestExecutionMessageSchema, startTestExecutionSchema } from "./agentRevisionRequestSchemas.js";

const agentParams = z.object({ agentId: z.string().uuid() });
const executionParams = agentParams.extend({ executionId: z.string().uuid() });
const retryParams = executionParams.extend({ sideId: z.string().uuid() });
const retainParams = executionParams.extend({ sideId: z.string().uuid() });
const historyPageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).optional() });

interface TestExecutionRouteDependencies extends WorkspaceSessionDependencies {
  testExecutionService: TestExecutionService;
}

const presentSides = (sides: readonly (TestExecution["sides"][number] | TestExecutionHistoryItem["sides"][number])[]) =>
  sides.map((side) => ({
    id: side.id, revision: presentRevisionSummary(side.revision), conversationId: side.conversationId,
    state: side.state === "ready" ? "running" : side.state,
    retryable: side.retryable,
    history: "history" in side ? side.history.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })) : [],
  }));

const presentHistorySides = (sides: readonly (TestExecution["sides"][number] | TestExecutionHistoryItem["sides"][number])[]) =>
  sides.map((side) => ({
    id: side.id, revision: presentRevisionSummary(side.revision), conversationId: side.conversationId,
    state: side.state,
    retryable: side.retryable,
  }));

const present = (execution: TestExecution) => ({
  id: execution.id, generation: execution.generation, mode: execution.mode,
  sides: presentSides(execution.sides),
});

const presentHistory = (execution: TestExecutionHistoryItem) => ({
  id: execution.id, generation: execution.generation, mode: execution.mode,
  sides: presentHistorySides(execution.sides),
  state: execution.state,
  createdAt: execution.createdAt.toISOString(),
});

const presentDetail = (execution: TestExecution, attempts: readonly TestExecutionAttemptRecord[]) => {
  const historySides = presentHistorySides(execution.sides);
  return {
    ...presentHistory(execution),
    testValues: execution.testValues,
    sides: execution.sides.map((side, index) => ({
      ...historySides[index],
      history: side.history.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
    })),
    attempts: attempts.map((attempt) => ({
      ...attempt,
      leaseExpiresAt: attempt.leaseExpiresAt.toISOString(),
      createdAt: attempt.createdAt.toISOString(),
      updatedAt: attempt.updatedAt.toISOString(),
    })),
  };
};

const writeEvents = async (res: Response, events: AsyncIterable<TestExecutionEvent>) => {
  const iterator = events[Symbol.asyncIterator]();
  // A generator does not execute until next() is called. Prepare its first event before
  // committing SSE headers so scoped lookup/fencing errors remain ordinary JSON 404/409s.
  const first = await iterator.next();
  res.status(200).setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  let closed = false;
  res.once("close", () => { closed = true; });
  const heartbeat = setInterval(() => { if (!closed) res.write(": keepalive\n\n"); }, 15_000);
  try {
    if (!first.done && !closed) res.write(`event: ${first.value.type}\ndata: ${JSON.stringify(first.value)}\n\n`);
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      if (!closed) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  } catch {
    // SSE is already committed. The stream can only close here; forwarding the error to
    // Express would make its JSON error handler attempt a second response.
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
};

/**
 * Operator-only test routes. The server builder mounts this beneath
 * `/api/v1/agents`; it is intentionally not reachable from public channel routers.
 */
export const createTestExecutionRoutes = (dependencies: TestExecutionRouteDependencies): Router => {
  const router = Router();
  const session = requireWorkspaceSession(dependencies);
  const manage = requireWorkspacePermission(dependencies, "workspace.agents.manage");

  router.get("/:agentId/test-executions", session, manage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId } = agentParams.parse(req.params);
      const page = await dependencies.testExecutionService.list({ workspaceId, agentId, ...historyPageQuerySchema.parse(req.query) });
      res.json({ executions: page.executions.map(presentHistory), nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (error) { next(error); }
  });

  router.get("/:agentId/test-executions/:executionId", session, manage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId, executionId } = executionParams.parse(req.params);
      const detail = await dependencies.testExecutionService.detail({ workspaceId, agentId, executionId });
      res.json({ execution: presentDetail(detail.execution, detail.attempts) });
    } catch (error) { next(error); }
  });

  router.post("/:agentId/test-executions", session, manage, validateBody(startTestExecutionSchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string | null };
      const { agentId } = agentParams.parse(req.params);
      const execution = await dependencies.testExecutionService.start({ workspaceId, agentId, accountId: accountId ?? null, ...req.body });
      res.status(201).json(present(execution));
    } catch (error) { if (!res.headersSent) next(error); else res.end(); }
  });

  router.post("/:agentId/test-executions/:executionId/messages", session, manage, validateBody(sendTestExecutionMessageSchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string | null };
      const { agentId, executionId } = executionParams.parse(req.params);
      await writeEvents(res, dependencies.testExecutionService.streamMessage({ workspaceId, agentId, accountId: accountId ?? null, executionId, message: req.body.message, generation: req.body.executionGeneration, turnId: req.body.turnId, attemptId: req.body.attemptId }));
    } catch (error) { if (!res.headersSent) next(error); else res.end(); }
  });

  router.post("/:agentId/test-executions/:executionId/sides/:sideId/retain", session, manage, async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string | null };
      const { agentId, executionId, sideId } = retainParams.parse(req.params);
      const execution = await dependencies.testExecutionService.retainSide({ workspaceId, agentId, accountId: accountId ?? null, executionId, sideId });
      res.status(201).json(present(execution));
    } catch (error) { next(error); }
  });

  router.post("/:agentId/test-executions/:executionId/sides/:sideId/retry", session, manage, validateBody(retryTestExecutionSideSchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string | null };
      const { agentId, executionId, sideId } = retryParams.parse(req.params);
      await writeEvents(res, dependencies.testExecutionService.streamRetry({ workspaceId, agentId, accountId: accountId ?? null, executionId, sideId, generation: req.body.executionGeneration, turnId: req.body.turnId, attemptId: req.body.attemptId }));
    } catch (error) { if (!res.headersSent) next(error); else res.end(); }
  });
  return router;
};
