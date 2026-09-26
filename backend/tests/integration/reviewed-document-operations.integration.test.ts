import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
import { CopilotRepository } from "../../src/db/repositories/copilotRepository.js";
import { DocumentDeletionService } from "../../src/modules/documents/services/documentDeletionService.js";
import { DocumentIngestionService } from "../../src/modules/documents/services/documentIngestionService.js";
import { DocumentReviewedOperationService } from "../../src/modules/documents/services/documentReviewedOperationService.js";
import { describeDocumentReviewedOperationPlan } from "../../src/modules/documents/services/documentReviewedOperationPlan.js";
import { createDocumentReviewedOperationAdapter } from "../../src/modules/operatorCopilot/documentReviewedOperationAdapter.js";
import { OperatorCopilotService } from "../../src/modules/operatorCopilot/service.js";
import { canonicalReviewedOperationDigest } from "../../src/modules/operatorCopilot/reviewedOperation.js";
import { NoopDocumentCapacityReadPort, NoopUsageLimitPolicy } from "../../src/shared/domain/usageLimitPolicy.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("reviewed document operations (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const repository = new DocumentRepository(database.kysely);
  const copilotRepository = new CopilotRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const operatorUserId = randomUUID();
  const clientId = randomUUID();
  const clientRecordId = randomUUID();
  const snapshotId = randomUUID();
  const grantId = randomUUID();
  const credentialId = randomUUID();
  const membershipId = randomUUID();
  const audit = { async record() {} };
  const ingestion = new DocumentIngestionService(repository, audit as never);
  const deletion = new DocumentDeletionService(repository, { async upload() { throw new Error("not used"); }, async read() { throw new Error("not used"); }, async delete() {} }, audit as never);
  const operations = new DocumentReviewedOperationService(repository, ingestion, deletion, new NoopDocumentCapacityReadPort());
  const adapter = createDocumentReviewedOperationAdapter({ operations });
  const authorization = { async hasAllPermissions() { return true; } };
  const copilot = new OperatorCopilotService({
    repository: copilotRepository,
    capabilityRunner: { runStreaming: async function* () {} } as never,
    usageLimitPolicy: new NoopUsageLimitPolicy(), auditService: audit, prompt: "test",
    workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "reviewed" }, currentAuthorization: authorization,
    tools: [], proposalAdapters: [adapter],
  });

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)", [accountId, "Reviewed documents", `reviewed-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)", [workspaceId, accountId, "Reviewed documents", `reviewed-${workspaceId}`]);
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)", [operatorUserId, `reviewed-user-${operatorUserId}@example.com`, "hash"]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1,$2,$3,'owner','active')", [membershipId, accountId, operatorUserId]);
    await database.query("INSERT INTO operator_mcp_clients (id, client_id, registration_method, application_type, display_name, redirect_uris, metadata_digest) VALUES ($1,$2,'preregistered','native','Reviewed tests','[]'::jsonb,'digest')", [clientRecordId, clientId]);
    await database.query("INSERT INTO operator_mcp_client_metadata_snapshots (id, client_id, client_version, metadata_digest, normalized_metadata, source, validated_at) VALUES ($1,$2,1,'digest','{}'::jsonb,'compatibility',NOW())", [snapshotId, clientRecordId]);
    await database.query("INSERT INTO operator_mcp_grants (id, client_id, client_version, client_metadata_snapshot_id, account_id, workspace_id, user_id, membership_id, resource, tool_scopes, credential_epoch) VALUES ($1,$2,1,$3,$4,$5,$6,$7,'operator-mcp',ARRAY['operator:propose','operator:act']::text[],1)", [grantId, clientRecordId, snapshotId, accountId, workspaceId, operatorUserId, membershipId]);
    await database.query("INSERT INTO operator_mcp_access_credentials (id, grant_id, token_digest, issued_grant_version, issued_client_version, issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes, issued_offline_access, expires_at) VALUES ($1,$2,$3,1,1,$4,1,ARRAY['operator:propose','operator:act']::text[],false,NOW() + interval '1 day')", [credentialId, grantId, `credential-${credentialId}`, snapshotId]);
    await database.query("INSERT INTO operator_mcp_deployment_credential_state (resource, credential_epoch, key_fingerprint) VALUES ('operator-mcp',1,'test')");
  });

  afterEach(async () => {
    await database.query("DELETE FROM documents WHERE workspace_id = $1", [workspaceId]);
  });

  afterAll(async () => {
    await database.query("DELETE FROM copilot_proposals WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_invocations WHERE workspace_id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_access_credentials WHERE id = $1", [credentialId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_grants WHERE id = $1", [grantId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_client_metadata_snapshots WHERE id = $1", [snapshotId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_clients WHERE id = $1", [clientRecordId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_deployment_credential_state WHERE resource = 'operator-mcp'").catch(() => undefined);
    await database.query("DELETE FROM account_memberships WHERE id = $1", [membershipId]).catch(() => undefined);
    await database.query("DELETE FROM users WHERE id = $1", [operatorUserId]).catch(() => undefined);
    await database.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]).catch(() => undefined);
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const read = async (externalDocumentId: string) => repository.findActivePageState({ workspaceId, sourceId: null, externalDocumentId });
  const prepareImport = (documents: readonly { externalDocumentId: string; title: string; content: string }[]) => operations.prepareImport({ workspaceId, accountId, sourceId: null, documents });
  const insertInvocation = async (id: string, descriptorName: string, status: "admitted" | "running" = "admitted") => database.query(
    "INSERT INTO operator_mcp_invocations (id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id, method, descriptor_name, shape, input_digest, proof_nonce_digest, retained_until, status) VALUES ($1,$2,$3,1,$4,$5,$6,$7,'tools/call',$8,'propose','digest',$9,NOW() + interval '1 day',$10)",
    [id, credentialId, grantId, accountId, workspaceId, operatorUserId, clientRecordId, descriptorName, `proof-${id}`, status],
  );

  it("imports idempotently and replaces a changed external id in place", async () => {
    const first = await prepareImport([
      { externalDocumentId: "law-1", title: "Law 1", content: "first" },
      { externalDocumentId: "law-2", title: "Law 2", content: "second" },
    ]);
    await expect(operations.import({ workspaceId, accountId, sourceId: null, documents: first.documents })).resolves.toMatchObject({ counts: { created: 2 } });
    const law1 = await read("law-1");

    const replay = await prepareImport([
      { externalDocumentId: "law-1", title: "Law 1", content: "first" },
      { externalDocumentId: "law-2", title: "Law 2", content: "second" },
    ]);
    expect(describeDocumentReviewedOperationPlan(replay).review).toMatchObject({ counts: { create: 0, replace: 0, unchanged: 2 } });
    await expect(operations.import({ workspaceId, accountId, sourceId: null, documents: replay.documents })).resolves.toMatchObject({ counts: { unchanged: 2 } });

    const replacement = await prepareImport([{ externalDocumentId: "law-1", title: "Law 1 amended", content: "amended" }]);
    await operations.import({ workspaceId, accountId, sourceId: null, documents: replacement.documents });
    const amended = await read("law-1");
    expect(amended?.documentId).toBe(law1?.documentId);
    expect(amended?.revision).toBeGreaterThan(law1?.revision ?? 0);
    const [count] = await database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM documents WHERE workspace_id = $1 AND external_document_id = 'law-1'", [workspaceId]);
    expect(count?.count).toBe("1");
  });

  it("refuses an import fence when normal ingestion changes the reviewed row", async () => {
    await ingestion.ingest({ workspaceId, accountId, externalDocumentId: "law-1", title: "Law", content: "old" });
    const plan = await prepareImport([{ externalDocumentId: "law-1", title: "Law", content: "reviewed replacement" }]);
    await ingestion.ingest({ workspaceId, accountId, externalDocumentId: "law-1", title: "Law", content: "newer writer" });

    await expect(operations.import({ workspaceId, accountId, sourceId: null, documents: plan.documents })).resolves.toMatchObject({ counts: { failed: 1 }, failures: [{ externalDocumentId: "law-1", code: "conflict" }] });
    const after = await read("law-1");
    expect(after?.contentHash).not.toBe(plan.documents[0]?.contentHash);
  });

  it("reimports a failed external id as the normal guarded replacement target", async () => {
    const first = await ingestion.ingest({ workspaceId, accountId, externalDocumentId: "failed-law", title: "Failed", content: "old" });
    await database.query("UPDATE documents SET status = 'failed' WHERE id = $1", [first.documentId]);
    const plan = await prepareImport([{ externalDocumentId: "failed-law", title: "Recovered", content: "new" }]);
    expect(plan.documents[0]).toMatchObject({ action: "replace", expectedDocumentId: first.documentId });
    await expect(operations.import({ workspaceId, accountId, sourceId: null, documents: plan.documents })).resolves.toMatchObject({ counts: { replaced: 1 } });
    const after = await read("failed-law");
    expect(after?.documentId).toBe(first.documentId);
    expect(after?.revision).toBeGreaterThan(1);
  });

  it("resumes an interrupted import and settles a lost execute response without duplicate ingests", async () => {
    const plan = await prepareImport([
      { externalDocumentId: "law-1", title: "Law 1", content: "first" },
      { externalDocumentId: "law-2", title: "Law 2", content: "second" },
      { externalDocumentId: "law-3", title: "Law 3", content: "third" },
    ]);
    const preparationId = randomUUID(); const executionId = randomUUID();
    await insertInvocation(preparationId, "prepare_document_import", "running");
    await insertInvocation(executionId, "execute_reviewed_proposal");
    const targetRef = { sourceId: null };
    const payload = { operation: "import" as const, documents: plan.documents, fence: plan.fence };
    const { review, fullReview } = describeDocumentReviewedOperationPlan(plan);
    const reviewSnapshot = { review, fullReview };
    const digest = canonicalReviewedOperationDigest({ targetRef, payload, versionToken: plan.fence, reviewSnapshot });
    const proposal = await copilotRepository.createProposal({ workspaceId, operatorUserId, origin: { type: "operator_mcp_invocation", invocationId: preparationId }, targetType: "document_operation", targetRef, payload, versionToken: plan.fence, evidence: null, reviewDigest: digest, reviewSnapshot, expiresAt: new Date(Date.now() + 60_000) });
    // Simulate the first target landing before the transport dies. The reviewed execute must
    // recognize that guarded target as already applied and write only the remaining two.
    await operations.import({ workspaceId, accountId, sourceId: null, documents: [plan.documents[0]] });
    const reconciliation = await copilot.executeMcpReviewedProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id, reviewDigest: digest, executionInvocationId: executionId, grantId, clientId: clientRecordId, currentAuthorization: authorization, now: new Date() });
    expect(reconciliation).toMatchObject({ status: "applied", appliedRef: { counts: { created: 3 } } });
    const outcome = await copilot.getMcpReviewedProposal({ workspaceId, accountId, operatorUserId, grantId, clientId: clientRecordId, proposalId: proposal.id });
    expect(outcome?.proposal.appliedRef).toMatchObject({ counts: { created: 3 } });
    const replay = await copilot.executeMcpReviewedProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id, reviewDigest: digest, executionInvocationId: executionId, grantId, clientId: clientRecordId, currentAuthorization: authorization, now: new Date() });
    expect(replay).toMatchObject({ status: "applied", appliedRef: { counts: { created: 3 } } });
    for (const externalDocumentId of ["law-1", "law-2", "law-3"]) {
      const after = await read(externalDocumentId);
      const [jobs] = await database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM document_processing_jobs WHERE document_id = $1", [after?.documentId]);
      expect(jobs?.count).toBe("1");
    }
  });

  it("uses removal CAS, then reports deleted targets as already removed", async () => {
    const ids = await Promise.all(["a", "b", "c"].map(async (externalDocumentId) => (await ingestion.ingest({ workspaceId, accountId, externalDocumentId, title: externalDocumentId, content: externalDocumentId })).documentId));
    const plan = await operations.prepareRemoval({ workspaceId, documentIds: ids, externalDocumentIds: [], sourceId: null });
    await ingestion.ingest({ workspaceId, accountId, externalDocumentId: "b", title: "b", content: "changed" });
    const first = await operations.remove({ workspaceId, documents: plan.documents });
    expect(first.counts).toMatchObject({ removed: 2, changed: 1 });
    const second = await operations.remove({ workspaceId, documents: plan.documents });
    expect(second.counts).toMatchObject({ alreadyRemoved: 2, changed: 1 });
  });

  it("reprocesses only the all-selector snapshot", async () => {
    const first = await ingestion.ingest({ workspaceId, accountId, externalDocumentId: "first", title: "first", content: "first" });
    await database.query("UPDATE documents SET status = 'ready' WHERE id = $1", [first.documentId]);
    const plan = await operations.prepareReprocess({ workspaceId, kind: "all" });
    const later = await ingestion.ingest({ workspaceId, accountId, externalDocumentId: "later", title: "later", content: "later" });
    await database.query("UPDATE documents SET status = 'ready' WHERE id = $1", [later.documentId]);
    await operations.reprocess({ workspaceId, kind: "documents", documentIds: plan.documents.map((document) => document.id), documents: plan.documents });
    const laterRow = await repository.findByIdAndWorkspaceId(later.documentId, workspaceId);
    expect(laterRow?.status).toBe("ready");
  });

  it("resumes an interrupted reprocess without queueing the advanced target twice", async () => {
    const ids = await Promise.all(["one", "two", "three"].map(async (externalDocumentId) => {
      const created = await ingestion.ingest({ workspaceId, accountId, externalDocumentId, title: externalDocumentId, content: externalDocumentId });
      await database.query("UPDATE documents SET status = 'ready' WHERE id = $1", [created.documentId]);
      return created.documentId;
    }));
    const plan = await operations.prepareReprocess({ workspaceId, kind: "documents", documentIds: ids });
    await operations.reprocess({ workspaceId, kind: "documents", documentIds: [ids[0]], documents: [plan.documents.find((document) => document.id === ids[0])!] });
    const resumed = await operations.reprocess({ workspaceId, kind: "documents", documentIds: plan.documents.map((document) => document.id), documents: plan.documents });
    expect(resumed).toMatchObject({ queued: 2, skipped: 1, failed: 0 });
    for (const id of ids) {
      const [jobs] = await database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM document_processing_jobs WHERE document_id = $1", [id]);
      expect(jobs?.count).toBe("2");
    }
  });

  it("settles a reviewed reprocess after one target was already queued", async () => {
    const ids = await Promise.all(["review-one", "review-two", "review-three"].map(async (externalDocumentId) => {
      const created = await ingestion.ingest({ workspaceId, accountId, externalDocumentId, title: externalDocumentId, content: externalDocumentId });
      await database.query("UPDATE documents SET status = 'ready' WHERE id = $1", [created.documentId]);
      return created.documentId;
    }));
    const plan = await operations.prepareReprocess({ workspaceId, kind: "documents", documentIds: ids });
    await operations.reprocess({ workspaceId, kind: "documents", documentIds: [ids[0]], documents: [plan.documents.find((document) => document.id === ids[0])!] });
    const preparationId = randomUUID(); const executionId = randomUUID();
    await insertInvocation(preparationId, "prepare_document_reprocess", "running");
    await insertInvocation(executionId, "execute_reviewed_proposal");
    const targetRef = { sourceId: null }; const payload = { operation: "reprocess" as const, documents: plan.documents, fence: plan.fence };
    const reviewSnapshot = { review: { kind: "documents", eligible: 3, skipped: 0 }, fullReview: { documents: plan.documents } };
    const digest = canonicalReviewedOperationDigest({ targetRef, payload, versionToken: plan.fence, reviewSnapshot });
    const proposal = await copilotRepository.createProposal({ workspaceId, operatorUserId, origin: { type: "operator_mcp_invocation", invocationId: preparationId }, targetType: "document_operation", targetRef, payload, versionToken: plan.fence, evidence: null, reviewDigest: digest, reviewSnapshot, expiresAt: new Date(Date.now() + 60_000) });
    await expect(copilot.executeMcpReviewedProposal({ workspaceId, accountId, operatorUserId, proposalId: proposal.id, reviewDigest: digest, executionInvocationId: executionId, grantId, clientId: clientRecordId, currentAuthorization: authorization, now: new Date() }))
      .resolves.toMatchObject({ status: "applied", appliedRef: { queued: 2, skipped: 1, failed: 0 } });
    const outcome = await copilot.getMcpReviewedProposal({ workspaceId, accountId, operatorUserId, grantId, clientId: clientRecordId, proposalId: proposal.id });
    expect(outcome?.proposal.status).toBe("applied");
  });

  it("refuses capacity before writing any document", async () => {
    const limitedUsage = new class extends NoopDocumentCapacityReadPort {
      async getDocumentCapacityUsage() {
        return { storedDocuments: { used: 99, limit: 100 }, storedIndexedBytes: { used: 0, limit: null }, monthlyIndexedBytes: { used: 0, limit: null } };
      }
    }();
    const limited = new DocumentReviewedOperationService(repository, ingestion, deletion, limitedUsage);
    await expect(limited.prepareImport({ workspaceId, accountId, sourceId: null, documents: [
      { externalDocumentId: "one", title: "one", content: "one" }, { externalDocumentId: "two", title: "two", content: "two" },
    ] })).rejects.toMatchObject({ code: "bad_request", message: "Import would exceed stored_documents: limit 100, current 99, requested new 2." });
    const [count] = await database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM documents WHERE workspace_id = $1", [workspaceId]);
    expect(count?.count).toBe("0");
  });
});
