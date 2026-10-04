/**
 * Real-process Operator MCP acceptance smoke, including local account setup
 * and the actual OAuth authorization-code/PKCE flow.
 *
 * Required environment:
 * MCP1150_ACCEPTANCE_DATABASE_URL  disposable URL whose database is mcp1150_final_test
 * OPERATOR_MCP_INTERNAL_SECRET, OPERATOR_MCP_CREDENTIAL_EPOCH
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const backendPort = 55101;
const mcpPort = 55102;
const backendUrl = `http://127.0.0.1:${backendPort}`;
const resourceUrl = `http://127.0.0.1:${mcpPort}/operator/mcp`;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const expectStatus = (response: Response, expected: number, label: string): Response => {
  // OAuth responses can carry codes or tokens. Status is sufficient diagnostic
  // context here; never echo a response body into a local acceptance log.
  assert.equal(response.status, expected, `${label} returned HTTP ${response.status}`);
  return response;
};

const waitFor = async (url: string): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const stop = async (process: ChildProcess): Promise<void> => {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([once(process, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (process.exitCode === null) process.kill("SIGKILL");
};

const databaseUrl = required("MCP1150_ACCEPTANCE_DATABASE_URL");
const database = new Pool({ connectionString: databaseUrl, max: 1 });
const databaseTarget = new URL(databaseUrl);
assert.equal(databaseTarget.hostname, "127.0.0.1", "acceptance harness requires the local disposable database");
assert.equal(databaseTarget.port, "59842", "acceptance harness requires the integration database port");
assert.equal(databaseTarget.pathname, "/mcp1150_final_test", "acceptance harness refuses a non-final disposable database");
const secret = required("OPERATOR_MCP_INTERNAL_SECRET");
const epoch = required("OPERATOR_MCP_CREDENTIAL_EPOCH");
// This account exists only in the explicitly guarded disposable database above.
// Registration can be closed in a realistic local runtime, so reuse it when it is.
const fixtureEmail = process.env.MCP1150_FIXTURE_EMAIL ?? "mcp1150-af4567c8-9ef8-4e3d-afd2-fb722f9dbc25@example.test";

const backend = spawn("pnpm", ["exec", "tsx", "tests/acceptance/operatorAuthoringBackend.ts"], {
  cwd: new URL("../../../backend/", import.meta.url),
  env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(backendPort), OPERATOR_MCP_RESOURCE_URL: resourceUrl, OPERATOR_MCP_ISSUER_URL: backendUrl, OPERATOR_MCP_INTERNAL_SECRET: secret, OPERATOR_MCP_CREDENTIAL_EPOCH: epoch },
  stdio: "inherit",
});
let mcp: ChildProcess | undefined;
const clientPort = 55103;
const redirectUri = `http://127.0.0.1:${clientPort}/callback`;
const clientId = `http://127.0.0.1:${clientPort}/client.json`;
const mcpMetadata = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "MCP 1150 local acceptance", version: "1.0.0" },
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
};
const client = createServer((request, response) => {
  if (request.url === "/client.json") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ client_id: clientId, client_name: "MCP 1150 local acceptance", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", application_type: "native" }));
    return;
  }
  response.statusCode = 204;
  response.end();
});

try {
  await new Promise<void>((resolve) => client.listen(clientPort, "127.0.0.1", resolve));
  await waitFor(`${backendUrl}/health`);
  const registered = await fetch(`${backendUrl}/api/v1/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `mcp1150-${randomUUID()}@example.test`, password: "mcp1150-local-fixture-password", organizationName: "MCP 1150 acceptance" }),
  });
  const authenticated = registered.status === 201
    ? registered
    : await fetch(`${backendUrl}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: fixtureEmail, password: "mcp1150-local-fixture-password" }),
    });
  expectStatus(authenticated, registered.status === 201 ? 201 : 200, registered.status === 201 ? "account registration" : "fixture login");
  const registration = await authenticated.json() as { workspaceId: string };
  const cookie = authenticated.headers.getSetCookie().join("; ");
  const verifier = "v".repeat(43);
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const authorize = new URL(`${backendUrl}/api/v1/operator-mcp/oauth/authorize`);
  authorize.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "operator:read operator:probe operator:act operator:propose operator:write", state: "mcp1150", code_challenge: challenge, code_challenge_method: "S256", resource: resourceUrl }).toString();
  const started = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
  expectStatus(started, 302, "OAuth authorization");
  const transactionId = new URL(started.headers.get("location")!).searchParams.get("transaction");
  assert.ok(transactionId);
  const decided = await fetch(`${backendUrl}/api/v1/operator-mcp/oauth/transactions/${transactionId}/decision`, {
    method: "POST", headers: { cookie, "content-type": "application/json", "x-radioso-csrf": "1" },
    body: JSON.stringify({ decision: "approve", workspaceId: registration.workspaceId, approvedToolScopes: ["operator:read", "operator:probe", "operator:act", "operator:propose", "operator:write"] }),
  });
  expectStatus(decided, 200, "OAuth consent decision");
  const decision = await decided.json() as { redirectUri?: string; redirectUrl?: string };
  const redirect = new URL(decision.redirectUri ?? decision.redirectUrl!);
  const exchange = await fetch(`${backendUrl}/api/v1/operator-mcp/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: redirect.searchParams.get("code")!, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier, resource: resourceUrl }),
  });
  expectStatus(exchange, 200, "OAuth token exchange");
  const token = (await exchange.json() as { access_token: string }).access_token;
  const createdAgent = await fetch(`${backendUrl}/api/v1/agents`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-radioso-csrf": "1", "x-workspace-id": registration.workspaceId },
    body: JSON.stringify({ name: "MCP retrieval acceptance" }),
  });
  expectStatus(createdAgent, 201, "agent creation");
  const agent = await createdAgent.json() as { id: string };
  const createdSkill = await fetch(`${backendUrl}/api/v1/agents/${agent.id}/skills`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-workspace-id": registration.workspaceId },
    body: JSON.stringify({ name: "answer_with_sources", capability: "retrieve", target: { kind: "source_scope", id: null }, config: { sourceScope: "all", vectorTopK: 12, rerankEnabled: true, rerankTopK: 8, exposedInputs: { query: true } }, invocationMode: "default_answer", enabled: true }),
  });
  expectStatus(createdSkill, 201, "default retrieval skill creation");
  mcp = spawn("pnpm", ["exec", "tsx", "src/cli/http.ts"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, RADIOSO_BASE_URL: backendUrl, RADIOSO_MCP_BIND_HOST: "127.0.0.1", RADIOSO_MCP_BIND_PORT: String(mcpPort), OPERATOR_MCP_RESOURCE_URL: resourceUrl, OPERATOR_MCP_ISSUER_URL: backendUrl, OPERATOR_MCP_INTERNAL_SECRET: secret, OPERATOR_MCP_CREDENTIAL_EPOCH: epoch },
    stdio: "inherit",
  });
  await waitFor(`http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource/operator/mcp`);
  const metadata = await fetch(`http://127.0.0.1:${mcpPort}/.well-known/oauth-protected-resource/operator/mcp`);
  assert.equal(metadata.status, 200);
  const listed = await fetch(resourceUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "mcp-method": "tools/list", "mcp-protocol-version": "2026-07-28" }, body: JSON.stringify({ jsonrpc: "2.0", id: "mcp1150-list", method: "tools/list", params: { _meta: mcpMetadata } }) });
  expectStatus(listed, 200, "authenticated tools/list");
  const tools = await listed.json() as { result?: { tools?: Array<{ name: string }> } };
  assert.ok(tools.result?.tools?.some((tool) => tool.name === "execute_reviewed_proposal"));
  assert.ok(tools.result?.tools?.some((tool) => tool.name === "prepare_agent_settings"));
  assert.ok(tools.result?.tools?.some((tool) => tool.name === "prepare_ingestion_settings"));
  const mcpCall = async (id: string, name: string, arguments_: Record<string, unknown>, operationId = id) => {
    const response = await fetch(resourceUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "mcp-method": "tools/call", "mcp-name": name, "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_, operationId, _meta: mcpMetadata } }),
    });
    expectStatus(response, 200, `${name} MCP call`);
    return response.json() as Promise<{
      result?: {
        structuredContent?: Record<string, unknown>;
        safeOutcomeCode?: string;
        resultReference?: string;
      };
      error?: unknown;
    }>;
  };
  const baselinePublication = await mcpCall("mcp1150-settings-baseline-publication", "prepare_agent_publication", { agentId: agent.id });
  const baselinePublicationReview = baselinePublication.result?.structuredContent;
  const baselinePublished = await mcpCall("mcp1150-settings-baseline-publication-execute", "execute_reviewed_proposal", { proposalId: baselinePublicationReview!.proposalId, reviewDigest: baselinePublicationReview!.reviewDigest });
  assert.equal(baselinePublished.result?.structuredContent?.status, "applied");
  const baselinePublicationState = await mcpCall("mcp1150-settings-baseline-publication-state", "agent_publication_state", { agentId: agent.id });
  const baselinePublishedRevisionId = baselinePublicationState.result?.structuredContent?.publishedRevisionId;
  assert.equal(typeof baselinePublishedRevisionId, "string", "baseline publication must establish the live revision");

  const agentSettings = await mcpCall("mcp1150-agent-settings-prepare", "prepare_agent_settings", {
    agentId: agent.id,
    patch: { name: "MCP reviewed settings", customInstruction: "Answer with the operator-approved policy." },
  });
  const agentSettingsReview = agentSettings.result?.structuredContent;
  assert.equal(typeof agentSettingsReview?.proposalId, "string", "agent settings proposal id is required");
  assert.equal(typeof agentSettingsReview?.reviewDigest, "string", "agent settings review digest is required");
  const agentSettingsChanges = (agentSettingsReview?.review as { changes?: Array<{ key?: string; lifecycle?: string }> } | undefined)?.changes;
  assert.equal(agentSettingsChanges?.find((change) => change.key === "name")?.lifecycle, "live");
  assert.equal(agentSettingsChanges?.find((change) => change.key === "customInstruction")?.lifecycle, "agent_draft");
  let agentSettingsExecuteCalls = 0;
  const executeAgentSettingsIfConfirmed = async (decision: "confirmed" | "declined" | "absent") => {
    if (decision !== "confirmed") return null;
    agentSettingsExecuteCalls += 1;
    return mcpCall("mcp1150-agent-settings-execute", "execute_reviewed_proposal", {
      proposalId: agentSettingsReview!.proposalId,
      reviewDigest: agentSettingsReview!.reviewDigest,
    });
  };
  for (const decision of ["declined", "absent"] as const) {
    assert.equal(await executeAgentSettingsIfConfirmed(decision), null);
    assert.equal(agentSettingsExecuteCalls, 0);
    const unchanged = await mcpCall(`mcp1150-agent-settings-${decision}`, "agent_configuration", { mode: "detail", agentId: agent.id });
    assert.equal((unchanged.result?.structuredContent?.agent as { name?: string } | undefined)?.name, "MCP retrieval acceptance");
  }
  const agentSettingsExecuted = await executeAgentSettingsIfConfirmed("confirmed");
  assert.equal(agentSettingsExecuteCalls, 1);
  assert.equal(agentSettingsExecuted?.result?.structuredContent?.status, "applied");
  const agentSettingsReadback = await mcpCall("mcp1150-agent-settings-readback", "agent_configuration", { mode: "detail", agentId: agent.id });
  assert.equal((agentSettingsReadback.result?.structuredContent?.agent as { name?: string } | undefined)?.name, "MCP reviewed settings");
  const draftOnlyState = await mcpCall("mcp1150-agent-settings-draft-state", "agent_publication_state", { agentId: agent.id });
  assert.equal(draftOnlyState.result?.structuredContent?.publishedRevisionId, baselinePublishedRevisionId, "customInstruction remains draft-only until publication");
  assert.ok((draftOnlyState.result?.structuredContent?.draftGeneration as number) > (baselinePublicationState.result?.structuredContent?.draftGeneration as number));

  const ingestionBefore = await mcpCall("mcp1150-ingestion-settings-before", "workspace_settings", {});
  const currentChunkSize = (ingestionBefore.result?.structuredContent?.ingestion as { fixedWindowChunkSize?: number } | undefined)?.fixedWindowChunkSize;
  assert.equal(typeof currentChunkSize, "number", "workspace ingestion settings are required");
  const nextChunkSize = currentChunkSize === 1_500 ? 1_600 : 1_500;
  const ingestionSettings = await mcpCall("mcp1150-ingestion-settings-prepare", "prepare_ingestion_settings", { fixedWindowChunkSize: nextChunkSize });
  const ingestionSettingsReview = ingestionSettings.result?.structuredContent;
  assert.equal(typeof ingestionSettingsReview?.proposalId, "string", "ingestion settings proposal id is required");
  assert.equal(typeof ingestionSettingsReview?.reviewDigest, "string", "ingestion settings review digest is required");
  let ingestionSettingsExecuteCalls = 0;
  const executeIngestionSettingsIfConfirmed = async (decision: "confirmed" | "declined" | "absent") => {
    if (decision !== "confirmed") return null;
    ingestionSettingsExecuteCalls += 1;
    return mcpCall("mcp1150-ingestion-settings-execute", "execute_reviewed_proposal", {
      proposalId: ingestionSettingsReview!.proposalId,
      reviewDigest: ingestionSettingsReview!.reviewDigest,
    });
  };
  for (const decision of ["declined", "absent"] as const) {
    assert.equal(await executeIngestionSettingsIfConfirmed(decision), null);
    assert.equal(ingestionSettingsExecuteCalls, 0);
    const unchanged = await mcpCall(`mcp1150-ingestion-settings-${decision}`, "workspace_settings", {});
    assert.equal((unchanged.result?.structuredContent?.ingestion as { fixedWindowChunkSize?: number } | undefined)?.fixedWindowChunkSize, currentChunkSize);
  }
  const ingestionSettingsExecuted = await executeIngestionSettingsIfConfirmed("confirmed");
  assert.equal(ingestionSettingsExecuteCalls, 1);
  assert.equal(ingestionSettingsExecuted?.result?.structuredContent?.status, "applied");
  const ingestionSettingsReadback = await mcpCall("mcp1150-ingestion-settings-readback", "workspace_settings", {});
  assert.equal((ingestionSettingsReadback.result?.structuredContent?.ingestion as { fixedWindowChunkSize?: number } | undefined)?.fixedWindowChunkSize, nextChunkSize);

  const inspected = await mcpCall("mcp1150-retrieval-read", "retrieval_settings", { agentId: agent.id });
  assert.ok(inspected.result?.structuredContent, `retrieval settings result is required: ${JSON.stringify(inspected)}`);
  const prepared = await mcpCall("mcp1150-retrieval-prepare", "prepare_retrieval_settings", { agentId: agent.id, patch: { vectorTopK: 17 } });
  const review = prepared.result?.structuredContent;
  assert.equal(typeof review?.proposalId, "string", "reviewed proposal id is required");
  assert.equal(typeof review?.reviewDigest, "string", "review digest is required");
  // This is the trusted-client boundary. The service binds the reviewed operation, while the
  // client decides whether it received an explicit human confirmation before sending execution.
  let executeCalls = 0;
  const executeIfConfirmed = async (decision: "confirmed" | "declined" | "absent") => {
    if (decision !== "confirmed") return null;
    executeCalls += 1;
    return mcpCall("mcp1150-retrieval-execute", "execute_reviewed_proposal", { proposalId: review!.proposalId, reviewDigest: review!.reviewDigest });
  };
  for (const decision of ["declined", "absent"] as const) {
    assert.equal(await executeIfConfirmed(decision), null);
    assert.equal(executeCalls, 0);
    const unchanged = await mcpCall(`mcp1150-retrieval-${decision}`, "retrieval_settings", { agentId: agent.id });
    assert.equal((unchanged.result?.structuredContent?.agent as { settings?: { vectorTopK?: number } } | undefined)?.settings?.vectorTopK, 12);
  }
  const executed = await executeIfConfirmed("confirmed");
  assert.equal(executeCalls, 1);
  assert.ok(executed);
  assert.equal(executed.result?.structuredContent?.status, "applied");
  const readback = await mcpCall("mcp1150-retrieval-readback", "retrieval_settings", { agentId: agent.id });
  assert.equal((readback.result?.structuredContent?.agent as { settings?: { vectorTopK?: number } } | undefined)?.settings?.vectorTopK, 17);
  const replay = await mcpCall("mcp1150-retrieval-execute-retry", "execute_reviewed_proposal", { proposalId: review!.proposalId, reviewDigest: review!.reviewDigest }, "mcp1150-retrieval-execute");
  // A new transport request with the same logical operation is acknowledged from
  // the durable invocation receipt; the detailed result remains available below.
  assert.equal(replay.result?.safeOutcomeCode, "completed");
  assert.equal(replay.result?.resultReference, review!.proposalId);
  const outcome = await mcpCall("mcp1150-retrieval-outcome", "reviewed_proposal_outcome", { proposalId: review!.proposalId });
  assert.equal(outcome.result?.structuredContent?.status, "applied");
  const routineDraft = { name: "MCP returns", enabled: false, activation: { triggerDescription: "Handle return requests", gateRef: null, priority: 0, reentryMode: "once_per_conversation" }, slots: [], steps: [{ stableStepId: "start", kind: "chat", instruction: "Collect the order number.", toolRef: null, ordinal: 0, metadata: {} }], transitions: [{ fromStep: "start", toRef: "done", guardKind: "default", ordinal: 0 }], terminals: [{ stableStepId: "done", kind: "complete", instruction: "Finish the return request.", ordinal: 1 }] };
  const routineCreate = await mcpCall("mcp1150-routine-create", "prepare_routine_structure", { kind: "create", agentId: agent.id, draft: routineDraft });
  const routineCreateReview = routineCreate.result?.structuredContent;
  const routineCreated = await mcpCall("mcp1150-routine-create-execute", "execute_reviewed_proposal", { proposalId: routineCreateReview!.proposalId, reviewDigest: routineCreateReview!.reviewDigest });
  assert.equal(routineCreated.result?.structuredContent?.status, "applied");
  const routineId = (routineCreated.result?.structuredContent?.appliedRef as { routineId?: string } | undefined)?.routineId;
  assert.equal(typeof routineId, "string");
  const routineAfterCreate = await mcpCall("mcp1150-routine-created-read", "routine_definition", { agentId: agent.id, routineId });
  assert.equal((routineAfterCreate.result?.structuredContent?.routine as { enabled?: boolean } | undefined)?.enabled, false);
  let offset = 0; let canonicalJson = "";
  do {
    const chunk = await mcpCall(`mcp1150-routine-authoring-${offset}`, "routine_definition", { agentId: agent.id, routineId, authoringDetail: { offset, limit: 4000 } });
    const detail = chunk.result?.structuredContent?.authoringDetail as { text?: string; nextOffset?: number | null } | undefined;
    assert.equal(typeof detail?.text, "string");
    canonicalJson += detail!.text;
    offset = detail!.nextOffset ?? -1;
  } while (offset >= 0);
  const canonicalStep = (JSON.parse(canonicalJson) as { steps?: Array<Record<string, unknown>> }).steps?.[0];
  assert.ok(canonicalStep, "routine_definition must expose a canonical editable step");
  const routineUpdate = await mcpCall("mcp1150-routine-update", "prepare_routine_structure", { kind: "edit", agentId: agent.id, routineId, operations: [{ kind: "replace_step", previous: canonicalStep, next: { ...canonicalStep, instruction: "Collect the return order number." } }] });
  const routineUpdateReview = routineUpdate.result?.structuredContent;
  const routineUpdated = await mcpCall("mcp1150-routine-update-execute", "execute_reviewed_proposal", { proposalId: routineUpdateReview!.proposalId, reviewDigest: routineUpdateReview!.reviewDigest });
  assert.equal(routineUpdated.result?.structuredContent?.status, "applied");
  const routineAfterUpdate = await mcpCall("mcp1150-routine-updated-read", "routine_definition", { agentId: agent.id, routineId });
  assert.ok(JSON.stringify(routineAfterUpdate.result?.structuredContent).includes("Collect the return order number."));
  const routineDelete = await mcpCall("mcp1150-routine-delete", "prepare_routine_structure", { kind: "delete", agentId: agent.id, routineId });
  const routineDeleteReview = routineDelete.result?.structuredContent;
  const routineDeleted = await mcpCall("mcp1150-routine-delete-execute", "execute_reviewed_proposal", { proposalId: routineDeleteReview!.proposalId, reviewDigest: routineDeleteReview!.reviewDigest });
  assert.equal(routineDeleted.result?.structuredContent?.status, "applied");
  const routinesAfterDelete = await mcpCall("mcp1150-routine-deleted-read", "routine_definition", { agentId: agent.id });
  assert.equal((routinesAfterDelete.result?.structuredContent?.routineCount as number | undefined) ?? 0, 0);
  const publication = await mcpCall("mcp1150-publication-prepare", "prepare_agent_publication", { agentId: agent.id });
  const publicationReview = publication.result?.structuredContent;
  assert.equal(typeof publicationReview?.proposalId, "string");
  assert.equal(typeof publicationReview?.candidateRevisionId, "string");
  const candidate = await mcpCall("mcp1150-publication-candidate", "agent_publication_candidate", { agentId: agent.id, candidateRevisionId: publicationReview!.candidateRevisionId });
  assert.ok(candidate.result?.structuredContent);
  const published = await mcpCall("mcp1150-publication-execute", "execute_reviewed_proposal", { proposalId: publicationReview!.proposalId, reviewDigest: publicationReview!.reviewDigest });
  assert.equal(published.result?.structuredContent?.status, "applied");
  const originalAppliedRef = published.result?.structuredContent?.appliedRef;
  assert.ok(originalAppliedRef);
  const publishedBeforeRecovery = await database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM agent_revisions WHERE agent_id = $1 AND published_at IS NOT NULL", [agent.id]);
  // Fault injection for the only state a lost owner response can leave behind: the owner
  // committed publication, while the reviewed proposal still has its stale receipt lease.
  // The retry below travels through the actual MCP edge, application service, descriptor, and
  // publication adapter; it must reconcile the idempotency key rather than publish again.
  await database.query("UPDATE copilot_proposals SET status = 'pending', applied_ref = NULL, apply_started_at = NOW() - INTERVAL '5 minutes' WHERE id = $1", [publicationReview!.proposalId]);
  await database.query("UPDATE operator_mcp_invocations SET status = 'completed', safe_outcome_code = 'completed', completed_at = NOW() WHERE id = (SELECT execution_invocation_id FROM copilot_proposals WHERE id = $1)", [publicationReview!.proposalId]);
  const recoveredPublication = await mcpCall("mcp1150-publication-execute-retry", "execute_reviewed_proposal", { proposalId: publicationReview!.proposalId, reviewDigest: publicationReview!.reviewDigest }, "mcp1150-publication-execute");
  assert.equal(recoveredPublication.result?.structuredContent?.status, "applied");
  assert.deepEqual(recoveredPublication.result?.structuredContent?.appliedRef, originalAppliedRef);
  const publishedAfterRecovery = await database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM agent_revisions WHERE agent_id = $1 AND published_at IS NOT NULL", [agent.id]);
  assert.equal(publishedAfterRecovery.rows[0]?.count, publishedBeforeRecovery.rows[0]?.count, "publication recovery must not publish a second revision");
  const publicationOutcome = await mcpCall("mcp1150-publication-outcome", "reviewed_proposal_outcome", { proposalId: publicationReview!.proposalId });
  assert.equal(publicationOutcome.result?.structuredContent?.status, "applied");
  const cancellation = await mcpCall("mcp1150-cancel-prepare", "prepare_retrieval_settings", { agentId: agent.id, patch: { vectorTopK: 18 } });
  const cancellationReview = cancellation.result?.structuredContent;
  assert.equal(typeof cancellationReview?.proposalId, "string");
  const cancelled = await mcpCall("mcp1150-cancel", "cancel_reviewed_proposal", { proposalId: cancellationReview!.proposalId });
  assert.equal(cancelled.result?.structuredContent?.status, "dismissed");
  const refused = await mcpCall("mcp1150-cancel-execute", "execute_reviewed_proposal", { proposalId: cancellationReview!.proposalId, reviewDigest: cancellationReview!.reviewDigest });
  assert.equal(refused.result?.structuredContent?.status, "refused");
  console.info("operator MCP real-process reviewed authoring acceptance passed");
} finally {
  if (mcp) await stop(mcp);
  await stop(backend);
  await database.end().catch(() => undefined);
  await new Promise<void>((resolve) => client.close(() => resolve()));
}
