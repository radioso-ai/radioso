import { randomUUID } from "node:crypto";

import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RevisionEvalRunRepository } from "../../src/db/repositories/revisionEvalRunRepository.js";
import type { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import type { EvalCase, EvalSnapshot } from "../../src/modules/eval/domain/types.js";
import { createRevisionEvalRoutes } from "../../src/modules/eval/routes/revisionEvalRoutes.js";
import { RevisionEvalRunService } from "../../src/modules/eval/services/revisionEvalRun.js";
import { Database } from "../../src/shared/infra/database.js";
import { runAllTestMigrations } from "../support/databaseMigrations.js";

const url = process.env.INTEGRATION_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("revision eval run HTTP routes", () => {
  const accountId = randomUUID(), retryingAccountId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), revisionId = randomUUID(), otherRevisionId = randomUUID(), snapshotId = randomUUID(), caseId = randomUUID(), conversationId = randomUUID();
  const candidate: AgentRevision = { id: revisionId, sourceDraftGeneration: 1, sourceBasePublishedRevisionId: null, createdAt: new Date(0), publishedAt: null, publishedVersion: null, snapshot: { customInstruction: "candidate", directives: [], routines: [], contextVariableEnablements: [] } };
  const snapshot: EvalSnapshot = { id: snapshotId, workspaceId, sourceConversationId: conversationId, sourceMessageId: null, replayTarget: null, fidelity: "full", messages: [{ id: randomUUID(), role: "user", content: "retrieve this", createdAt: new Date().toISOString() }], originalInstructionBlock: null, originalModelId: null, originalRetrievalSettings: null, originalAgent: null, originalAgentConfig: null, sourceAgentId: agentId, originalRoutineState: null, originalRetrievalResult: null, capturedAt: new Date().toISOString(), capturedBy: null };
  const evalCase: EvalCase = { id: caseId, workspaceId, snapshotId, name: "case", assertions: [], executionMode: "safe_test", status: "pending", lastRunId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let database: Database;

  beforeAll(async () => {
    database = new Database(url!);
    await runAllTestMigrations(database);
    await database.query("INSERT INTO accounts (id,name,email,password_hash) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)", [accountId, "route eval", `route-eval-${accountId}@example.com`, "hash", retryingAccountId, "retry actor", `route-eval-${retryingAccountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id,account_id,name,public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "route eval", `route-eval-${workspaceId}`]);
    await database.query("INSERT INTO agents (id,workspace_id,name) VALUES ($1,$2,$3)", [agentId, workspaceId, "agent"]);
    await database.query("INSERT INTO conversations (id,workspace_id,agent_id) VALUES ($1,$2,$3)", [conversationId, workspaceId, agentId]);
    await database.query("INSERT INTO agent_revisions (id,agent_id,workspace_id,snapshot,source_draft_generation) VALUES ($1,$2,$3,$4::jsonb,1)", [revisionId, agentId, workspaceId, JSON.stringify(candidate.snapshot)]);
    await database.query("INSERT INTO eval_snapshots (id,workspace_id,source_conversation_id,source_agent_id,fidelity,messages) VALUES ($1,$2,$3,$4,'full',$5::jsonb)", [snapshotId, workspaceId, conversationId, agentId, JSON.stringify(snapshot.messages)]);
    await database.query("INSERT INTO eval_cases (id,workspace_id,snapshot_id,name,status,assertions,execution_mode) VALUES ($1,$2,$3,$4,'pending','[]'::jsonb,'safe_test')", [caseId, workspaceId, snapshotId, "case"]);
  });
  afterAll(async () => { await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined); await database.query("DELETE FROM accounts WHERE id = $1", [retryingAccountId]).catch(() => undefined); await database.close(); });

  it("resolves the scoped owner without an agentId, maps pending polling to running, and retries with the originating actor", async () => {
    const repository = new RevisionEvalRunRepository(database.kysely);
    let providerFails = true;
    const runnerAccounts: Array<string | null | undefined> = [];
    const ownerLookups: string[] = [];
    const service = new RevisionEvalRunService({
      repository,
      revisions: {
        async findRevisionByWorkspace(input) { ownerLookups.push(input.revisionId); return input.revisionId === revisionId ? { agentId, revision: candidate } : input.revisionId === otherRevisionId ? { agentId: otherAgentId, revision: { ...candidate, id: otherRevisionId } } : null; },
        async findRevision(_input) { return null; },
      },
      cases: { async findCase(_workspaceId, id) { return id === caseId ? evalCase : null; }, async findSnapshot() { return snapshot; } },
      contextCatalog: { async get() { return null; } },
      runner: {
        async executeFrozenRevisionCase(input) {
          runnerAccounts.push(input.accountId);
          return providerFails
            ? { status: "error" as const, outcomeReason: "runner_failed", assertionVerdicts: [], observedOutput: { retrievedChunks: [], error: { message: "revision_eval_runner_failed", code: "runner_failed" } }, resolvedConfig: {} }
            : { status: "pass" as const, outcomeReason: null, assertionVerdicts: [], observedOutput: { retrievedChunks: [] }, resolvedConfig: {} };
        },
      },
    });
    let sessionAccountId = accountId;
    const permissions: string[] = [];
    const app = express();
    app.use(express.json());
    app.use((req: Request & { cookies: Record<string, string> }, _res: Response, next: NextFunction) => { req.cookies = { radioso_session: "test" }; next(); });
    app.use("/api/v1/evals", createRevisionEvalRoutes({
      env: { SESSION_COOKIE_NAME: "radioso_session" },
      authService: { async authenticateSession() { return { accountId: sessionAccountId, userId: "user", sessionId: "session" }; } },
      workspaceSessionService: { async resolve() { return { accountId: sessionAccountId, workspaceId }; } },
      accountAccessService: {
        async requireActiveMembership() {},
        async requirePermission(input: Parameters<AccountAccessService["requirePermission"]>[0]) {
          permissions.push(input.permission);
        },
      },
      revisionEvalRunService: service,
    } as never));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const known = error as { statusCode?: number; code?: string };
      res.status(known.statusCode ?? 500).json({ error: { code: known.code ?? "internal_error" } });
    });
    const body = { revisionIds: [revisionId], caseIds: [caseId], testValues: [], mode: "retrieval_only", executionPolicy: "safe_test" };
    const created = await request(app).post("/api/v1/evals/revision-runs").send(body).expect(201);
    expect(created.body.state).toBe("running");
    expect(ownerLookups).toEqual([revisionId]);
    const runId = created.body.id as string;
    const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
      throw new Error("revision eval route did not reach expected state");
    };
    await waitFor(async () => (await repository.find({ workspaceId, runId }))?.state === "failed");
    const polled = await request(app).get(`/api/v1/evals/revision-runs/${runId}`).expect(200);
    expect(polled.body.state).toBe("failed");

    sessionAccountId = retryingAccountId;
    providerFails = false;
    await request(app).post(`/api/v1/evals/revision-runs/${runId}/sides/${revisionId}/cases/${caseId}/retry`).send({}).expect(200);
    await waitFor(async () => (await repository.find({ workspaceId, runId }))?.state === "completed");
    expect(permissions).toContain("workspace.agents.manage");
    expect(runnerAccounts).toEqual([accountId, accountId]);

    await request(app).post("/api/v1/evals/revision-runs").send({ ...body, revisionIds: [otherRevisionId] }).expect(404);
  });
});
