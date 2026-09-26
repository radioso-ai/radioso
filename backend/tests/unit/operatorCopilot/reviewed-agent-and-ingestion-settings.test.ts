import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { createAgentSettingsReviewedPreparationTool } from "../../../src/modules/operatorCopilot/tools/agentSettingsReviewedPreparation.js";
import { createIngestionSettingsReviewedPreparationTool } from "../../../src/modules/operatorCopilot/tools/ingestionSettingsReviewedPreparation.js";
import { createAgentSettingCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/proposalAdapters.js";
import { createIngestionSettingsCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/ingestionSettingsProposalAdapter.js";
import { createReviewedProposalExecutionTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";
import { createReviewedProposalOutcomeTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalOutcome.js";
import { createCancelReviewedProposalTool } from "../../../src/modules/operatorCopilot/tools/cancelReviewedProposal.js";
import { OperatorCopilotService } from "../../../src/modules/operatorCopilot/service.js";
import { canonicalReviewedOperationDigest } from "../../../src/modules/operatorCopilot/reviewedOperation.js";
import { badRequest } from "../../../src/shared/domain/errors.js";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "workspace-1";
const grantId = "grant-1";
const clientId = "client-1";

const baseContext = {
  workspaceId, accountId: "account-1", operatorUserId: "operator-1", surface: "mcp" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  operatorMcpGrantId: grantId, operatorMcpClientId: clientId,
  pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
};

const contextWithPermissions = (permissions: readonly string[], invocationId = randomUUID()) => ({
  ...baseContext,
  permissions: new Set(permissions),
  operatorMcpInvocationId: invocationId,
  currentAuthorization: { hasAllPermissions: vi.fn(async ({ requiredPermissions }: { requiredPermissions: readonly string[] }) => requiredPermissions.every((permission) => permissions.includes(permission))) },
});

const proposalDependencies = () => ({
  proposalRepository: { createProposal: vi.fn(async (input) => ({ id: randomUUID(), ...input })) },
  proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
  proposalAdapters: [], auditService: { record: vi.fn() }, now: () => new Date("2026-09-26T10:00:00.000Z"),
});

const ingestionPayloadFields = {
  chunkingStrategy: "fixed_window" as const, fixedWindowChunkSize: 1_500, fixedWindowChunkOverlap: 100,
  structuredMinChunkSize: 200, structuredMaxChunkSize: 2_000,
};

// ---------------------------------------------------------------------------------------------
// A minimal, in-memory stand-in for the reviewed-proposal state machine `CopilotRepository`
// implements against Postgres (digest/expiry fencing, claim/reclaim with a TTL lease, and settling
// the receipt). It exists so execution tests can exercise the real `OperatorCopilotService` and the
// real proposal adapters without a database; the exact compare-and-set/rollback guarantees this
// mirrors are proven against Postgres in the integration suite.
// ---------------------------------------------------------------------------------------------
interface FakeRow {
  id: string;
  workspaceId: string;
  operatorUserId: string;
  targetType: string;
  targetRef: unknown;
  payload: unknown;
  versionToken: string;
  reviewDigest: string | null;
  reviewSnapshot: unknown;
  expiresAt: Date | null;
  status: "pending" | "applied" | "stale" | "failed" | "dismissed";
  executionInvocationId: string | null;
  applyStartedAt: Date | null;
  appliedRef: unknown;
  reason: string | null;
  origin: { type: "operator_mcp_invocation"; invocationId: string };
  createdAt: Date;
  updatedAt: Date;
}

class FakeReviewedRepository {
  readonly rows = new Map<string, FakeRow>();

  seed(overrides: Partial<FakeRow> & { targetType: string; targetRef: unknown; payload: unknown }): FakeRow {
    const id = overrides.id ?? randomUUID();
    const now = new Date();
    const row: FakeRow = {
      id, workspaceId, operatorUserId: "operator-1", versionToken: "v1", reviewDigest: canonicalReviewedOperationDigest({ id }),
      reviewSnapshot: { review: {} }, expiresAt: new Date(now.getTime() + 15 * 60_000), status: "pending",
      executionInvocationId: null, applyStartedAt: null, appliedRef: null, reason: null,
      origin: { type: "operator_mcp_invocation", invocationId: randomUUID() }, createdAt: now, updatedAt: now,
      ...overrides,
    };
    this.rows.set(id, row);
    return row;
  }

  async createProposal(input: Record<string, unknown>) {
    return this.seed(input as never);
  }

  async findProposal({ id }: { id: string }) {
    return this.rows.get(id) ?? null;
  }

  async findMcpReviewedProposal({ id }: { id: string }) {
    return this.rows.get(id) ?? null;
  }

  async claimMcpReviewedProposalApply(input: { proposalId: string; executionInvocationId: string; reviewDigest: string; now: Date; claimTtlSeconds: number }) {
    const row = this.rows.get(input.proposalId);
    if (!row) return { status: "missing" as const };
    if (!row.reviewDigest || !row.expiresAt || row.reviewDigest !== input.reviewDigest) return { status: "digest_mismatch" as const };
    if (row.executionInvocationId === input.executionInvocationId && (row.status === "applied" || row.status === "stale" || row.status === "failed")) {
      return { status: "settled" as const, outcome: row.status, appliedRef: row.appliedRef, ...(row.reason ? { reason: row.reason } : {}) };
    }
    if (row.expiresAt <= input.now && row.executionInvocationId !== input.executionInvocationId) return { status: "expired" as const };
    if (row.status === "dismissed") return { status: "canceled" as const };
    if (row.status !== "pending") return { status: "not_prepared" as const };
    if (row.executionInvocationId && row.executionInvocationId !== input.executionInvocationId) return { status: "not_prepared" as const };
    const claimFree = !row.applyStartedAt || input.now.getTime() - row.applyStartedAt.getTime() >= input.claimTtlSeconds * 1_000;
    if (!claimFree) return { status: row.executionInvocationId === input.executionInvocationId ? "claim_held" as const : "not_prepared" as const };
    const previousAttemptStartedAt = row.applyStartedAt;
    row.executionInvocationId = input.executionInvocationId;
    row.applyStartedAt = input.now;
    row.updatedAt = input.now;
    return { status: "claimed" as const, claim: { proposal: { ...row }, claimedAt: input.now, previousAttemptStartedAt } };
  }

  async updateProposalOutcome(input: { id: string; status: FakeRow["status"]; appliedRef?: unknown; reason?: string | null; applyClaimGuard: { state: "held"; claimedAt: Date } | { state: "free"; claimTtlSeconds: number } }) {
    const row = this.rows.get(input.id);
    if (!row || row.status !== "pending") return null;
    if (input.applyClaimGuard.state === "held") {
      if (!row.applyStartedAt || row.applyStartedAt.getTime() !== input.applyClaimGuard.claimedAt.getTime()) return null;
    }
    row.status = input.status;
    row.reason = input.reason ?? null;
    row.appliedRef = input.appliedRef ?? null;
    row.updatedAt = new Date();
    return { ...row };
  }

  async cancelPendingProposal(input: { id: string }) {
    const row = this.rows.get(input.id);
    if (!row || row.status !== "pending" || row.applyStartedAt !== null || row.executionInvocationId !== null) return null;
    row.status = "dismissed";
    row.reason = null;
    row.appliedRef = null;
    row.updatedAt = new Date();
    return { ...row };
  }

  async releaseProposalApplyClaim(input: { id: string; claimedAt: Date }) {
    const row = this.rows.get(input.id);
    if (!row || !row.applyStartedAt || row.applyStartedAt.getTime() !== input.claimedAt.getTime()) return false;
    row.applyStartedAt = null;
    return true;
  }

  /** What composition's `createReviewedReceiptSettlement` does inside the owner's transaction: settle the receipt only if the exact claim it was handed is still open. */
  settleReviewedApply(input: { proposalId: string; executionInvocationId: string; claimedAt: Date; appliedRef: unknown }): boolean {
    const row = this.rows.get(input.proposalId);
    if (!row) return false;
    if (row.status !== "pending" || row.executionInvocationId !== input.executionInvocationId
      || !row.applyStartedAt || row.applyStartedAt.getTime() !== input.claimedAt.getTime()) return false;
    row.status = "applied";
    row.appliedRef = input.appliedRef;
    row.applyStartedAt = null;
    row.updatedAt = new Date();
    return true;
  }
}

/** Mirrors `createReviewedReceiptSettlement`, wired to the in-memory store instead of a Kysely transaction. */
const fakeReviewedReceipt = (repository: FakeReviewedRepository) => ({
  commitHook: vi.fn((input: { proposalId: string; executionInvocationId: string; claimedAt: Date; toAppliedRef: (committed: unknown) => unknown }) =>
    async (_transaction: unknown, committed: unknown) => {
      const settled = repository.settleReviewedApply({
        proposalId: input.proposalId, executionInvocationId: input.executionInvocationId,
        claimedAt: input.claimedAt, appliedRef: input.toAppliedRef(committed),
      });
      if (!settled) throw new Error("reviewed_proposal_receipt_conflict");
    }),
});

describe("prepare_agent_settings through the operator MCP catalog", () => {
  it("persists the digest, review snapshot, and a 15-minute expiry, without any owner mutation", async () => {
    const deps = proposalDependencies();
    const prepareFieldsProposal = vi.fn(async () => ({
      targetAgentId: agentId, agentName: "Support", normalizedPatch: { name: "Help Desk" },
      expectedFields: [{ key: "name", value: "Support" }],
      changes: [{ key: "name", current: "Support", proposed: "Help Desk", lifecycle: "live" as const, reach: false }],
      unchanged: [],
    }));
    const readFieldProposalVersion = vi.fn(async () => "fields:agent:v1");
    const descriptor = { ...createAgentSettingsReviewedPreparationTool({ ...deps, agentSettings: { prepareFieldsProposal, readFieldProposalVersion } }), mcpDisposition: operatorMcpDispositions.prepare_agent_settings };
    const catalog = new OperatorMcpCatalogService([descriptor]);

    const output = await catalog.invoke({
      name: "prepare_agent_settings", arguments: { agentId, patch: { name: "Help Desk" } },
      context: contextWithPermissions(["workspace.agents.manage"]), scopes: new Set(["operator:propose"]), signal: AbortSignal.timeout(1_000),
    }) as { proposalId: string; reviewDigest: string; expiresAt: string };

    expect(prepareFieldsProposal).toHaveBeenCalledTimes(1);
    expect(readFieldProposalVersion).toHaveBeenCalledTimes(1);
    expect(output.reviewDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(output.expiresAt).toBe("2026-09-26T10:15:00.000Z");
    expect(deps.proposalRepository.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "agent_setting", reviewDigest: output.reviewDigest, expiresAt: new Date(output.expiresAt),
      reviewSnapshot: expect.objectContaining({ changes: [expect.objectContaining({ key: "name" })] }),
    }));
  });

  it("refuses a caller without workspace.agents.manage before the owner is ever asked", async () => {
    const deps = proposalDependencies();
    const prepareFieldsProposal = vi.fn();
    const descriptor = { ...createAgentSettingsReviewedPreparationTool({ ...deps, agentSettings: { prepareFieldsProposal, readFieldProposalVersion: vi.fn() } }), mcpDisposition: operatorMcpDispositions.prepare_agent_settings };
    const catalog = new OperatorMcpCatalogService([descriptor]);

    await expect(catalog.invoke({
      name: "prepare_agent_settings", arguments: { agentId, patch: { name: "Help Desk" } },
      context: contextWithPermissions(["workspace.documents.manage"]), scopes: new Set(["operator:propose"]), signal: AbortSignal.timeout(1_000),
    })).rejects.toMatchObject({ code: "forbidden" });
    expect(prepareFieldsProposal).not.toHaveBeenCalled();
  });

  it("replays a stored preparation for a repeated operationId without a second owner call", async () => {
    const deps = proposalDependencies();
    const prepareFieldsProposal = vi.fn();
    const review = { target: { agentId, agentName: "Support" }, changes: [{ key: "name", before: "Support", after: "Help Desk", lifecycle: "live" as const, reach: false }], unchanged: [], effects: { liveKeys: ["name"], draftKeys: [], publicationRequired: false, reach: false } };
    const proposalRecovery = { recoverOperatorMcpProposal: vi.fn(async () => ({ status: "recovered" as const, proposal: { id: randomUUID(), targetType: "agent_setting" as const, reviewDigest: "d".repeat(43), expiresAt: new Date("2026-09-26T10:15:00.000Z"), reviewSnapshot: review } })) } as never;
    const descriptor = { ...createAgentSettingsReviewedPreparationTool({ ...deps, proposalRecovery, agentSettings: { prepareFieldsProposal, readFieldProposalVersion: vi.fn() } }), mcpDisposition: operatorMcpDispositions.prepare_agent_settings };
    const catalog = new OperatorMcpCatalogService([descriptor]);
    const invocation = { id: randomUUID(), grantId, operationId: "op-1", inputDigest: "digest" } as never;

    const recovered = await catalog.reconcileInvocation({
      name: "prepare_agent_settings", arguments: { agentId, patch: { name: "Help Desk" } }, invocation,
      context: contextWithPermissions(["workspace.agents.manage"]), scopes: new Set(["operator:propose"]),
      staleBefore: new Date(0), now: new Date(),
    });

    expect(recovered).toMatchObject({ status: "recovered", output: { reviewDigest: "d".repeat(43), review } });
    expect(prepareFieldsProposal).not.toHaveBeenCalled();
  });
});

describe("prepare_ingestion_settings through the operator MCP catalog", () => {
  it("persists the digest, review snapshot, and a 15-minute expiry, without any owner mutation", async () => {
    const deps = proposalDependencies();
    const prepareFieldProposal = vi.fn(async () => ({
      normalizedPatch: ingestionPayloadFields, expected: { fixedWindowChunkSize: 1_000 },
      display: { current: { fixedWindowChunkSize: 1_000 }, proposed: { fixedWindowChunkSize: 1_500 } },
    }));
    const readFieldProposalVersion = vi.fn(async () => "fields:ingestion:v1");
    const descriptor = { ...createIngestionSettingsReviewedPreparationTool({ ...deps, ingestionSettings: { prepareFieldProposal, readFieldProposalVersion } }), mcpDisposition: operatorMcpDispositions.prepare_ingestion_settings };
    const catalog = new OperatorMcpCatalogService([descriptor]);

    const output = await catalog.invoke({
      name: "prepare_ingestion_settings", arguments: { fixedWindowChunkSize: 1_500 },
      context: contextWithPermissions(["workspace.settings.manage"]), scopes: new Set(["operator:propose"]), signal: AbortSignal.timeout(1_000),
    }) as { proposalId: string; reviewDigest: string; expiresAt: string };

    expect(prepareFieldProposal).toHaveBeenCalledTimes(1);
    expect(output.reviewDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(output.expiresAt).toBe("2026-09-26T10:15:00.000Z");
    expect(deps.proposalRepository.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "ingestion_settings", reviewDigest: output.reviewDigest, expiresAt: new Date(output.expiresAt),
      targetRef: { expectedFields: { fixedWindowChunkSize: 1_000 } },
    }));
  });

  it("refuses a caller without workspace.settings.manage before the owner is ever asked", async () => {
    const deps = proposalDependencies();
    const prepareFieldProposal = vi.fn();
    const descriptor = { ...createIngestionSettingsReviewedPreparationTool({ ...deps, ingestionSettings: { prepareFieldProposal, readFieldProposalVersion: vi.fn() } }), mcpDisposition: operatorMcpDispositions.prepare_ingestion_settings };
    const catalog = new OperatorMcpCatalogService([descriptor]);

    await expect(catalog.invoke({
      name: "prepare_ingestion_settings", arguments: { fixedWindowChunkSize: 1_500 },
      context: contextWithPermissions(["workspace.agents.manage"]), scopes: new Set(["operator:propose"]), signal: AbortSignal.timeout(1_000),
    })).rejects.toMatchObject({ code: "forbidden" });
    expect(prepareFieldProposal).not.toHaveBeenCalled();
  });

  it("replays a stored preparation for a repeated operationId without a second owner call", async () => {
    const deps = proposalDependencies();
    const prepareFieldProposal = vi.fn();
    const review = { changes: [{ field: "fixedWindowChunkSize", before: 1_000, after: 1_500 }], after: { fixedWindowChunkSize: 1_500 }, effect: { appliesTo: "documents_processed_after_execution" as const, existingDocuments: "unchanged_until_reprocessed" as const, embeddingModel: "unchanged" as const } };
    const proposalRecovery = { recoverOperatorMcpProposal: vi.fn(async () => ({ status: "recovered" as const, proposal: { id: randomUUID(), targetType: "ingestion_settings" as const, reviewDigest: "e".repeat(43), expiresAt: new Date("2026-09-26T10:15:00.000Z"), reviewSnapshot: review } })) } as never;
    const descriptor = { ...createIngestionSettingsReviewedPreparationTool({ ...deps, proposalRecovery, ingestionSettings: { prepareFieldProposal, readFieldProposalVersion: vi.fn() } }), mcpDisposition: operatorMcpDispositions.prepare_ingestion_settings };
    const catalog = new OperatorMcpCatalogService([descriptor]);
    const invocation = { id: randomUUID(), grantId, operationId: "op-1", inputDigest: "digest" } as never;

    const recovered = await catalog.reconcileInvocation({
      name: "prepare_ingestion_settings", arguments: { fixedWindowChunkSize: 1_500 }, invocation,
      context: contextWithPermissions(["workspace.settings.manage"]), scopes: new Set(["operator:propose"]),
      staleBefore: new Date(0), now: new Date(),
    });

    expect(recovered).toMatchObject({ status: "recovered", output: { reviewDigest: "e".repeat(43), review } });
    expect(prepareFieldProposal).not.toHaveBeenCalled();
  });
});

/** Builds the real execute/outcome/cancel tools over a real `OperatorCopilotService`, wired to one target's real proposal adapter and a fake repository standing in for Postgres. */
const executionCatalog = (input: { repository: FakeReviewedRepository; adapters: readonly unknown[]; now: () => Date }) => {
  const service = new OperatorCopilotService({
    repository: input.repository, proposalAdapters: input.adapters as never,
    auditService: { record: vi.fn(async () => undefined) }, currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
    now: input.now,
  } as never);
  return new OperatorMcpCatalogService([
    { ...createReviewedProposalExecutionTool(service), mcpDisposition: operatorMcpDispositions.execute_reviewed_proposal },
    { ...createReviewedProposalOutcomeTool(service), mcpDisposition: operatorMcpDispositions.reviewed_proposal_outcome },
    { ...createCancelReviewedProposalTool(service), mcpDisposition: operatorMcpDispositions.cancel_reviewed_proposal },
  ]);
};

const executeContext = (invocationId = randomUUID()) => ({ ...baseContext, permissions: new Set<string>(), operatorMcpInvocationId: invocationId });

describe("executing a reviewed agent_setting operation", () => {
  const targetRef = { agentId, expectedFields: [{ key: "name", value: "Support" }] };
  const payload = { kind: "fields" as const, patch: { name: "Help Desk" } };

  it("applies through the owner's compare-and-set and settles the receipt with the exact appliedRef in one step", async () => {
    const repository = new FakeReviewedRepository();
    const row = repository.seed({ targetType: "agent_setting", targetRef, payload });
    const reviewedReceipt = fakeReviewedReceipt(repository);
    const applyFieldProposal = vi.fn(async (_workspaceId: string, prepared: { targetAgentId: string }, options?: { onCommitted?: (trx: unknown, committed: unknown) => Promise<void> }) => {
      await options?.onCommitted?.(undefined, { agentId: prepared.targetAgentId });
      return { status: "applied" as const };
    });
    const adapter = createAgentSettingCopilotProposalAdapter({ agentService: { applyFieldProposal } as never, reviewedReceipt: reviewedReceipt as never });
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => new Date() });

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest },
      context: executeContext(), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });

    expect(output).toMatchObject({ status: "applied", appliedRef: { agentId } });
    expect(reviewedReceipt.commitHook).toHaveBeenCalledTimes(1);
    expect(repository.rows.get(row.id)).toMatchObject({ status: "applied", appliedRef: { agentId } });
  });

  it("names every changed field when the fence is stale, without writing anything", async () => {
    const repository = new FakeReviewedRepository();
    const twoFieldRef = { agentId, expectedFields: [{ key: "name", value: "Support" }, { key: "internalName", value: "support-internal" }] };
    const row = repository.seed({ targetType: "agent_setting", targetRef: twoFieldRef, payload: { kind: "fields" as const, patch: { name: "Help Desk", internalName: "help-desk" } } });
    const applyFieldProposal = vi.fn(async () => ({ status: "changed" as const, fields: ["name", "internalName"] }));
    const adapter = createAgentSettingCopilotProposalAdapter({ agentService: { applyFieldProposal } as never, reviewedReceipt: fakeReviewedReceipt(repository) as never });
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => new Date() });

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest },
      context: executeContext(), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });

    expect(output).toMatchObject({ status: "stale", reason: "Fields changed: name, internalName" });
    expect(repository.rows.get(row.id)).toMatchObject({ status: "stale", appliedRef: null });
  });

  it("settles a validation refusal from the owner as failed", async () => {
    const repository = new FakeReviewedRepository();
    const row = repository.seed({ targetType: "agent_setting", targetRef, payload });
    const applyFieldProposal = vi.fn(async () => { throw badRequest("publicAgentAccessEnabled requires agentCardEnabled"); });
    const adapter = createAgentSettingCopilotProposalAdapter({ agentService: { applyFieldProposal } as never, reviewedReceipt: fakeReviewedReceipt(repository) as never });
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => new Date() });

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest },
      context: executeContext(), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });

    expect(output).toMatchObject({ status: "failed", reason: "publicAgentAccessEnabled requires agentCardEnabled" });
    expect(repository.rows.get(row.id)).toMatchObject({ status: "failed" });
  });

  it("keeps an infrastructure error uncertain, holding the claim, then settles once the same receipt retries after the lease", async () => {
    const repository = new FakeReviewedRepository();
    const row = repository.seed({ targetType: "agent_setting", targetRef, payload });
    const applyFieldProposal = vi.fn()
      .mockImplementationOnce(async () => { throw new Error("connection reset"); })
      .mockImplementationOnce(async (_workspaceId: string, prepared: { targetAgentId: string }, options?: { onCommitted?: (trx: unknown, committed: unknown) => Promise<void> }) => {
        await options?.onCommitted?.(undefined, { agentId: prepared.targetAgentId });
        return { status: "applied" as const };
      });
    const adapter = createAgentSettingCopilotProposalAdapter({ agentService: { applyFieldProposal } as never, reviewedReceipt: fakeReviewedReceipt(repository) as never });
    let now = new Date("2026-09-26T10:00:00.000Z");
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => now });
    const context = executeContext();

    const first = await catalog.invoke({ name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest }, context, scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000) });
    expect(first).toMatchObject({ status: "uncertain" });
    expect(repository.rows.get(row.id)).toMatchObject({ status: "pending" });

    now = new Date(now.getTime() + 301_000); // past the 300s apply-claim lease
    const second = await catalog.invoke({ name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest }, context, scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000) });

    expect(second).toMatchObject({ status: "applied", appliedRef: { agentId } });
    expect(applyFieldProposal).toHaveBeenCalledTimes(2);
    expect(repository.rows.get(row.id)).toMatchObject({ status: "applied" });
  });

  it("reconciles a claim an earlier crashed attempt never applied, then applies exactly once", async () => {
    const repository = new FakeReviewedRepository();
    const invocationId = randomUUID();
    const staleClaim = new Date("2026-09-26T09:50:00.000Z"); // more than 300s before `now` below
    const row = repository.seed({ targetType: "agent_setting", targetRef, payload, executionInvocationId: invocationId, applyStartedAt: staleClaim });
    const applyFieldProposal = vi.fn(async (_workspaceId: string, prepared: { targetAgentId: string }, options?: { onCommitted?: (trx: unknown, committed: unknown) => Promise<void> }) => {
      await options?.onCommitted?.(undefined, { agentId: prepared.targetAgentId });
      return { status: "applied" as const };
    });
    const adapter = createAgentSettingCopilotProposalAdapter({ agentService: { applyFieldProposal } as never, reviewedReceipt: fakeReviewedReceipt(repository) as never });
    const now = new Date("2026-09-26T10:00:00.000Z");
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => now });

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest },
      context: executeContext(invocationId), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });

    expect(output).toMatchObject({ status: "applied", appliedRef: { agentId } });
    expect(applyFieldProposal).toHaveBeenCalledTimes(1);
  });

  it("refuses execution after the operation was cancelled", async () => {
    const repository = new FakeReviewedRepository();
    const row = repository.seed({ targetType: "agent_setting", targetRef, payload });
    const applyFieldProposal = vi.fn();
    const adapter = createAgentSettingCopilotProposalAdapter({ agentService: { applyFieldProposal } as never, reviewedReceipt: fakeReviewedReceipt(repository) as never });
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => new Date() });

    await expect(catalog.invoke({ name: "cancel_reviewed_proposal", arguments: { proposalId: row.id }, context: executeContext(), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000) }))
      .resolves.toMatchObject({ status: "dismissed" });
    const output = await catalog.invoke({ name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest }, context: executeContext(), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000) });

    expect(output).toMatchObject({ status: "refused", reason: "canceled" });
    expect(applyFieldProposal).not.toHaveBeenCalled();
  });

  it("refuses an expired reviewed operation", async () => {
    const repository = new FakeReviewedRepository();
    const row = repository.seed({ targetType: "agent_setting", targetRef, payload, expiresAt: new Date("2026-09-26T09:00:00.000Z") });
    const applyFieldProposal = vi.fn();
    const adapter = createAgentSettingCopilotProposalAdapter({ agentService: { applyFieldProposal } as never, reviewedReceipt: fakeReviewedReceipt(repository) as never });
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => new Date("2026-09-26T10:00:00.000Z") });

    const output = await catalog.invoke({ name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest }, context: executeContext(), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000) });

    expect(output).toMatchObject({ status: "refused", reason: "expired" });
    expect(applyFieldProposal).not.toHaveBeenCalled();
  });

  it("refuses a digest that does not match the prepared review", async () => {
    const repository = new FakeReviewedRepository();
    const row = repository.seed({ targetType: "agent_setting", targetRef, payload });
    const applyFieldProposal = vi.fn();
    const adapter = createAgentSettingCopilotProposalAdapter({ agentService: { applyFieldProposal } as never, reviewedReceipt: fakeReviewedReceipt(repository) as never });
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => new Date() });

    const output = await catalog.invoke({ name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: canonicalReviewedOperationDigest({ different: true }) }, context: executeContext(), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000) });

    expect(output).toMatchObject({ status: "refused", reason: "digest_mismatch" });
    expect(applyFieldProposal).not.toHaveBeenCalled();
  });
});

describe("executing a reviewed ingestion_settings operation", () => {
  const targetRef = { expectedFields: { fixedWindowChunkSize: 1_000 } };
  const payload = { name: "Ingestion settings" as const, ...ingestionPayloadFields };

  it("applies through the owner's compare-and-set and settles the receipt with the exact appliedRef in one step", async () => {
    const repository = new FakeReviewedRepository();
    const row = repository.seed({ targetType: "ingestion_settings", targetRef, payload });
    const reviewedReceipt = fakeReviewedReceipt(repository);
    const applyFieldProposal = vi.fn(async (_workspaceId: string, _prepared: unknown, options?: { onCommitted?: (trx: unknown, committed: unknown) => Promise<void> }) => {
      await options?.onCommitted?.(undefined, { workspaceId });
      return { status: "applied" as const };
    });
    const adapter = createIngestionSettingsCopilotProposalAdapter({ ingestionSettings: { applyFieldProposal } as never, reviewedReceipt: reviewedReceipt as never });
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => new Date() });

    const output = await catalog.invoke({
      name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest },
      context: executeContext(), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000),
    });

    expect(output).toMatchObject({ status: "applied", appliedRef: { workspaceId } });
    expect(reviewedReceipt.commitHook).toHaveBeenCalledTimes(1);
    expect(repository.rows.get(row.id)).toMatchObject({ status: "applied", appliedRef: { workspaceId } });
  });

  it("settles a coupled-field validation refusal from the owner as failed", async () => {
    const repository = new FakeReviewedRepository();
    const row = repository.seed({ targetType: "ingestion_settings", targetRef, payload });
    const applyFieldProposal = vi.fn(async () => { throw badRequest("Overlap must be smaller than window"); });
    const adapter = createIngestionSettingsCopilotProposalAdapter({ ingestionSettings: { applyFieldProposal } as never, reviewedReceipt: fakeReviewedReceipt(repository) as never });
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => new Date() });

    const output = await catalog.invoke({ name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest }, context: executeContext(), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000) });

    expect(output).toMatchObject({ status: "failed", reason: "Overlap must be smaller than window" });
    expect(repository.rows.get(row.id)).toMatchObject({ status: "failed" });
  });

  it("names the changed field when the fence is stale, without writing anything", async () => {
    const repository = new FakeReviewedRepository();
    const row = repository.seed({ targetType: "ingestion_settings", targetRef, payload });
    const applyFieldProposal = vi.fn(async () => ({ status: "changed" as const, fields: ["fixedWindowChunkSize"] }));
    const adapter = createIngestionSettingsCopilotProposalAdapter({ ingestionSettings: { applyFieldProposal } as never, reviewedReceipt: fakeReviewedReceipt(repository) as never });
    const catalog = executionCatalog({ repository, adapters: [adapter], now: () => new Date() });

    const output = await catalog.invoke({ name: "execute_reviewed_proposal", arguments: { proposalId: row.id, reviewDigest: row.reviewDigest }, context: executeContext(), scopes: new Set(["operator:write"]), signal: AbortSignal.timeout(1_000) });

    expect(output).toMatchObject({ status: "stale", reason: "Field changed: fixedWindowChunkSize" });
  });
});
