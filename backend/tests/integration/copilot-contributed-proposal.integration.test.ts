import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { getEnv } from "../../src/app/config/env.js";
import { buildDependencies } from "../../src/app/server/dependencies.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import { CopilotConflictError } from "../../src/modules/operatorCopilot/public.js";
import {
  ALERT_LIMIT_TOOL,
  ALERT_THRESHOLD_PRESENTATION,
  ALERT_THRESHOLD_TARGET_TYPE,
  ALERT_THRESHOLD_TOOL,
  createAlertLimitModule,
  createAlertLimitState,
  createAlertThresholdModule,
  createAlertThresholdState,
  writeAlertLimit,
} from "../support/contributedProposalModule.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// A module contributes a target type Ray has never heard of, and the real composition carries it
// through the whole proposal lifecycle against Postgres: Ray's propose tool drafts it, the
// repository stores and reloads it, the service reads it back and applies it through the same
// claim fence a first-party proposal goes through.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("a module-contributed Ray proposal target type (Postgres, real composition)", () => {
  const state = createAlertThresholdState();
  const limitState = createAlertLimitState();
  let deps: AppDependencies;
  let storageDir: string;
  let operator: { userId: string; accountId: string; workspaceId: string };

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "copilot-contributed-proposal-"));
    const env = getEnv({
      NODE_ENV: "test",
      DATABASE_URL: integrationDatabaseUrl,
      OPENAI_API_KEY: "test-key",
      LLM_PROVIDER: "openai",
      SESSION_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
      WORKSPACE_TOKEN_SECRET: "fedcba9876543210fedcba9876543210",
      WORKER_DISPATCH_DRIVER: "noop",
      DOCUMENT_STORAGE_DRIVER: "local",
      DOCUMENT_STORAGE_LOCAL_PATH: join(storageDir, "documents"),
    });
    deps = buildDependencies(env, { modules: [createAlertThresholdModule(state), createAlertLimitModule(limitState)] });
    // Seeded directly: self-service signup closes once the shared integration database has a user.
    operator = { userId: randomUUID(), accountId: randomUUID(), workspaceId: randomUUID() };
    await deps.connectorDb.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [operator.accountId, "Contributed Proposal Co", `contributed-proposal-${operator.accountId}@example.com`, "hash"]);
    await deps.connectorDb.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [operator.userId, `contributed-proposal-operator-${operator.userId}@example.com`, "hash"]);
    await deps.connectorDb.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [operator.workspaceId, operator.accountId, "Contributed Proposal Workspace", `route-${operator.workspaceId}`]);
    await deps.accountAccessService.ensureMembership({ accountId: operator.accountId, userId: operator.userId, role: "owner" });
  }, 60_000);

  afterAll(async () => {
    await deps?.applicationModules.shutdownAll().catch(() => undefined);
    await deps?.realtimePublisherLifecycle.shutdown().catch(() => undefined);
    await deps?.connectorDb.close().catch(() => undefined);
    await rm(storageDir, { recursive: true, force: true });
  }, 30_000);

  const principal = () => ({ workspaceId: operator.workspaceId, accountId: operator.accountId, operatorUserId: operator.userId });

  /** Drafts through the catalog's own descriptor, in a Ray conversation, as a turn would. */
  const proposeWith = async (toolName: string, input: Record<string, unknown>) => {
    const conversation = await deps.copilotRepository.createConversation({ workspaceId: operator.workspaceId, operatorUserId: operator.userId, title: "Contributed proposal" });
    const descriptor = deps.copilotToolCatalog.find((candidate) => candidate.name === toolName);
    if (!descriptor) throw new Error(`Expected ${toolName} in the copilot catalog`);
    const output = await descriptor.createTool({
      ...principal(),
      surface: "dashboard",
      copilotConversationId: conversation.id,
      currentAuthorization: { hasAllPermissions: async () => true },
      pageContext: { view: "other", agentId: null, conversationId: null, selection: null, entities: [] },
    }).invoke(input, {} as never) as { proposalId: string; targetType: string; targetLabel: string; summary: string; presentation: unknown };
    return { conversationId: conversation.id, output };
  };
  const propose = (threshold: number) => proposeWith(ALERT_THRESHOLD_TOOL, { threshold });
  /** What an earlier apply left: it claimed the proposal and died before recording what it did. */
  const abandonClaim = async (proposalId: string) => {
    const claim = await deps.copilotRepository.claimProposalApply({ id: proposalId, workspaceId: operator.workspaceId, operatorUserId: operator.userId, claimTtlSeconds: 300 });
    expect(claim).not.toBeNull();
    return {
      age: () => deps.connectorDb.query("UPDATE copilot_proposals SET apply_started_at = now() - interval '10 minutes' WHERE id = $1", [proposalId]),
    };
  };

  const apply = (proposalId: string) => deps.operatorCopilotService.applyProposal({ ...principal(), surface: "dashboard", proposalId });

  it("proposes, stores, lists, reads, and applies a contributed proposal once", async () => {
    const { conversationId, output } = await propose(500);
    expect(output).toMatchObject({ targetType: ALERT_THRESHOLD_TARGET_TYPE, targetLabel: "Alert at 500 answers", presentation: ALERT_THRESHOLD_PRESENTATION });

    await expect(deps.copilotRepository.findProposal({ id: output.proposalId, workspaceId: operator.workspaceId, operatorUserId: operator.userId })).resolves.toMatchObject({
      targetType: ALERT_THRESHOLD_TARGET_TYPE,
      status: "pending",
      payload: { name: "Alert at 500 answers", presentation: ALERT_THRESHOLD_PRESENTATION, change: { threshold: 500 } },
    });

    // A finished turn attaches its proposals to the answer it streamed; a reload reads them back.
    const message = await deps.copilotRepository.createMessage({ conversationId, role: "copilot", content: "Here is a threshold to review.", outcome: "completed", activity: [] });
    await deps.copilotRepository.attachProposalsToMessage({ proposalIds: [output.proposalId], messageId: message.id, conversationId });
    const reloaded = await deps.operatorCopilotService.get(operator.workspaceId, operator.userId, conversationId);
    expect(reloaded?.messages.find((candidate) => candidate.id === message.id)?.proposals).toEqual([{
      id: output.proposalId,
      targetType: ALERT_THRESHOLD_TARGET_TYPE,
      targetLabel: "Alert at 500 answers",
      summary: output.summary,
      status: "pending",
      reason: null,
      presentation: ALERT_THRESHOLD_PRESENTATION,
    }]);

    await expect(deps.operatorCopilotService.getProposal({ ...principal(), proposalId: output.proposalId })).resolves.toMatchObject({
      preview: { targetLabel: "Alert at 500 answers", current: null, proposed: { threshold: 500 } },
      currentVersionMatches: true,
    });
    await expect(deps.operatorCopilotService.getProposalDetail({ ...principal(), proposalId: output.proposalId })).resolves.toMatchObject({
      targetType: ALERT_THRESHOLD_TARGET_TYPE,
      summary: output.summary,
    });

    await expect(apply(output.proposalId)).resolves.toMatchObject({ status: "applied", appliedRef: { alertId: expect.any(String) } });
    expect(state.created.filter((alert) => alert.threshold === 500)).toHaveLength(1);
    await expect(apply(output.proposalId)).rejects.toBeInstanceOf(CopilotConflictError);
    expect(state.created.filter((alert) => alert.threshold === 500)).toHaveLength(1);
  });

  it("does not apply a create a second time when it retakes an interrupted apply's claim", async () => {
    const { output } = await propose(750);
    const claim = await abandonClaim(output.proposalId);
    // A live claim keeps a second Apply out.
    await expect(apply(output.proposalId)).rejects.toBeInstanceOf(CopilotConflictError);
    await claim.age();

    // The claim is retaken once it is abandoned, and the create-shaped adapter is not run again.
    await expect(apply(output.proposalId)).resolves.toEqual({ status: "failed", reason: expect.stringMatching(/interrupted/u) });
    expect(state.created.filter((alert) => alert.threshold === 750)).toHaveLength(0);
    await expect(deps.copilotRepository.findProposal({ id: output.proposalId, workspaceId: operator.workspaceId, operatorUserId: operator.userId })).resolves.toMatchObject({ status: "failed" });
  });

  it("settles a retryable contribution stale, with no second effect, when the interrupted apply took effect", async () => {
    const { output } = await proposeWith(ALERT_LIMIT_TOOL, { limit: 900 });
    const claim = await abandonClaim(output.proposalId);
    // The earlier attempt wrote the limit, moving its version, then died before recording it.
    expect(writeAlertLimit(limitState, 900, "v1")).toBe(true);
    await claim.age();

    // The adapter may be retried, and its compare-and-set sees the version moved.
    await expect(apply(output.proposalId)).resolves.toMatchObject({ status: "stale" });
    expect(limitState.writes).toBe(1);
    await expect(deps.copilotRepository.findProposal({ id: output.proposalId, workspaceId: operator.workspaceId, operatorUserId: operator.userId })).resolves.toMatchObject({ status: "stale" });
  });

  it("still loads a conversation holding a card of a target type this deployment no longer knows", async () => {
    const { conversationId, output } = await propose(1200);
    const message = await deps.copilotRepository.createMessage({ conversationId, role: "copilot", content: "Two proposals to review.", outcome: "completed", activity: [] });
    // Written by a revision whose module this one no longer registers.
    const retiredId = randomUUID();
    await deps.connectorDb.query(
      `INSERT INTO copilot_proposals (id, workspace_id, operator_user_id, conversation_id, target_type, target_ref, payload, version_token) VALUES ($1, $2, $3, $4, 'retired_alert_rule', '{}'::jsonb, '{"name":"Old rule","summary":"Old rule."}'::jsonb, 'create')`,
      [retiredId, operator.workspaceId, operator.userId, conversationId],
    );
    await deps.copilotRepository.attachProposalsToMessage({ proposalIds: [output.proposalId, retiredId], messageId: message.id, conversationId });

    const conversation = await deps.operatorCopilotService.get(operator.workspaceId, operator.userId, conversationId);

    expect(conversation?.messages.find((candidate) => candidate.id === message.id)?.proposals?.map((card) => card.id)).toEqual([output.proposalId]);
  });
});
