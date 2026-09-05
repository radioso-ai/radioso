import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { CopilotRepository } from "../../src/db/repositories/copilotRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { copilotProposalTargetTypes, type CopilotProposal } from "../../src/modules/operatorCopilot/public.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("CopilotRepository apply-claim recovery (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new CopilotRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const operatorUserId = randomUUID();

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [
      accountId,
      "Copilot Claim Co",
      `copilot-claim-${accountId}@example.com`,
      "hash",
    ]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [
      workspaceId,
      accountId,
      "Copilot Claim Workspace",
      `route-${workspaceId}`,
    ]);
    await database.query(`INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)`, [
      operatorUserId,
      `copilot-claim-operator-${operatorUserId}@example.com`,
      "hash",
    ]);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM copilot_conversations WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM users WHERE id = $1`, [operatorUserId]).catch(() => undefined);
    await database.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => undefined);
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const createPendingProposal = async (): Promise<CopilotProposal> => {
    const conversation = await repository.createConversation({ workspaceId, operatorUserId, title: "Claim recovery" });
    return repository.createProposal({
      workspaceId,
      operatorUserId,
      conversationId: conversation.id,
      targetType: "agent_setting",
      targetRef: { agentId: randomUUID(), settingKey: "retrievalEnabled" },
      payload: { value: true },
      versionToken: "v1",
      evidence: null,
    });
  };

  it("refuses a concurrent claim while the first is fresh, but reclaims once it is older than the TTL", async () => {
    const proposal = await createPendingProposal();

    const firstClaim = await repository.claimProposalApply({ id: proposal.id, workspaceId, operatorUserId, claimTtlSeconds: 300 });
    expect(firstClaim).not.toBeNull();

    // A concurrent apply on the same still-fresh claim must be refused — this is the exclusivity
    // the claim exists to guarantee, and recovery must not weaken it during normal operation.
    const concurrentClaim = await repository.claimProposalApply({ id: proposal.id, workspaceId, operatorUserId, claimTtlSeconds: 300 });
    expect(concurrentClaim).toBeNull();

    // Simulate a process that claimed and then crashed: back-date the claim past the TTL,
    // exactly what a real crash leaves behind (a claim timestamp nothing ever moves again).
    await database.query(`UPDATE copilot_proposals SET apply_started_at = $1 WHERE id = $2`, [
      new Date(Date.now() - 10_000),
      proposal.id,
    ]);

    const recoveredClaim = await repository.claimProposalApply({ id: proposal.id, workspaceId, operatorUserId, claimTtlSeconds: 5 });
    expect(recoveredClaim).not.toBeNull();
    expect(recoveredClaim!.proposal.id).toBe(proposal.id);
  });

  it("finalizes an outcome only for the exact claim it holds, so a superseded claim cannot overwrite a newer one's result", async () => {
    const proposal = await createPendingProposal();
    const claim = await repository.claimProposalApply({ id: proposal.id, workspaceId, operatorUserId, claimTtlSeconds: 300 });
    expect(claim).not.toBeNull();

    // A stale/foreign claim timestamp (as a crashed writer's late finalize would carry after
    // recovery reclaimed the row out from under it) must not be able to record an outcome.
    const rejected = await repository.updateProposalOutcome({
      id: proposal.id,
      workspaceId,
      operatorUserId,
      status: "applied",
      appliedRef: { ok: true },
      applyClaimGuard: { state: "held", claimedAt: new Date(claim!.claimedAt.getTime() - 1) },
    });
    expect(rejected).toBeNull();
    expect((await repository.findProposal({ id: proposal.id, workspaceId, operatorUserId }))?.status).toBe("pending");

    const accepted = await repository.updateProposalOutcome({
      id: proposal.id,
      workspaceId,
      operatorUserId,
      status: "applied",
      appliedRef: { ok: true },
      applyClaimGuard: { state: "held", claimedAt: claim!.claimedAt },
    });
    expect(accepted?.status).toBe("applied");
  });

  it("keeps dismiss blocked while a claim is active, but recovers it once the claim is stale — the operator is never stuck with no action", async () => {
    const activelyClaimed = await createPendingProposal();
    await repository.claimProposalApply({ id: activelyClaimed.id, workspaceId, operatorUserId, claimTtlSeconds: 300 });

    const blockedDismiss = await repository.updateProposalOutcome({
      id: activelyClaimed.id,
      workspaceId,
      operatorUserId,
      status: "dismissed",
      appliedRef: null,
      applyClaimGuard: { state: "free", claimTtlSeconds: 300 },
    });
    expect(blockedDismiss).toBeNull();

    const staleClaimed = await createPendingProposal();
    await repository.claimProposalApply({ id: staleClaimed.id, workspaceId, operatorUserId, claimTtlSeconds: 300 });
    await database.query(`UPDATE copilot_proposals SET apply_started_at = $1 WHERE id = $2`, [
      new Date(Date.now() - 10_000),
      staleClaimed.id,
    ]);

    const recoveredDismiss = await repository.updateProposalOutcome({
      id: staleClaimed.id,
      workspaceId,
      operatorUserId,
      status: "dismissed",
      appliedRef: null,
      applyClaimGuard: { state: "free", claimTtlSeconds: 5 },
    });
    expect(recoveredDismiss?.status).toBe("dismissed");

    const neverClaimed = await createPendingProposal();
    const plainDismiss = await repository.updateProposalOutcome({
      id: neverClaimed.id,
      workspaceId,
      operatorUserId,
      status: "dismissed",
      appliedRef: null,
      applyClaimGuard: { state: "free", claimTtlSeconds: 300 },
    });
    expect(plainDismiss?.status).toBe("dismissed");
  });

  // copilot_proposals.target_type carries a CHECK constraint, so a target type added to the runtime
  // list without a migration widening it drafts fine against every in-memory test double and then
  // fails on the first real write. Driving this from the list itself means the next target type
  // cannot forget the migration.
  it("stores a proposal for every declared target type", async () => {
    for (const targetType of copilotProposalTargetTypes) {
      const conversation = await repository.createConversation({ workspaceId, operatorUserId, title: `Target ${targetType}` });
      const proposal = await repository.createProposal({
        workspaceId,
        operatorUserId,
        conversationId: conversation.id,
        targetType,
        targetRef: { probe: targetType },
        payload: { name: targetType },
        versionToken: "v1",
        evidence: null,
      });
      expect(proposal.targetType).toBe(targetType);
    }
  });
});
