import type { CopilotMcpDisposition, CopilotToolDescriptor } from "./contracts.js";

const excluded = (reason: string): CopilotMcpDisposition => ({ status: "excluded", reason });

const contextDependent = excluded("Requires dashboard or Ray-conversation context that the stateless operator transport does not provide.");
const deferredRead = excluded("Read descriptor awaits a separate bounded-output and explicit-input MCP review after the limited rollout.");
const deferredProposal = excluded("Proposal descriptor awaits transport-neutral evidence and target-specific MCP review after the limited rollout.");
const unsafeAct = excluded("Act has no owner-approved lost-response, reconciliation, cancellation, and multi-instance MCP contract; GA gate remains closed.");
const customerReply = excluded("Customer reply drafting remains conversation-context behavior and is not part of the initial direct-tool catalog.");
const irreversibleDocumentRemoval = excluded("Applying this proposal permanently deletes the document and cannot be undone; use prepare_document_removal for the digest-bound reviewed execution flow.");

/** A read whose args are already explicit, target-scoped, and cleanly-throwing with no entity id: reviewed and widened together. */
const eligibleRead: CopilotMcpDisposition = {
  status: "eligible",
  inputStrategy: "explicit",
  scope: "operator:read",
  retry: { effect: "none", idempotent: true, operationIdentity: "client" },
};

/** A proposal whose evidence-citation no longer hard-requires a Ray conversation and whose descriptor owns a `reconcileMcpInvocation` recovery hook. */
const eligibleProposal: CopilotMcpDisposition = {
  status: "eligible",
  inputStrategy: "explicit",
  scope: "operator:propose",
  retry: { effect: "proposal", idempotent: true, operationIdentity: "client" },
};

export const operatorMcpDispositions: Readonly<Record<string, CopilotMcpDisposition>> = {
  agent_configuration: eligibleRead,
  agent_skills: eligibleRead,
  analyze_website: contextDependent,
  audience_topics: deferredRead,
  context_variables: eligibleRead,
  conversation_history_search: eligibleRead,
  conversation_transcript: eligibleRead,
  create_eval_case_from_turn: unsafeAct,
  draft_reply: customerReply,
  document_chunks: eligibleRead,
  list_documents: eligibleRead,
  document_search: eligibleRead,
  execute_reviewed_proposal: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:write",
    retry: { effect: "act", idempotent: true, operationIdentity: "input" },
  },
  reviewed_proposal_outcome: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:write",
    retry: { effect: "none", idempotent: true, operationIdentity: "client" },
  },
  cancel_reviewed_proposal: { status: "eligible", inputStrategy: "explicit", scope: "operator:write", retry: { effect: "act", idempotent: true, operationIdentity: "client" } },
  document_status: eligibleRead,
  eval_results: eligibleRead,
  needs_attention: contextDependent,
  product_doc_page: deferredRead,
  product_docs: deferredRead,
  propose_agent: deferredProposal,
  propose_agent_setting: eligibleProposal,
  propose_context_variable: eligibleProposal,
  propose_directive: eligibleProposal,
  propose_greeting: eligibleProposal,
  propose_document: eligibleProposal,
  propose_document_removal: irreversibleDocumentRemoval,
  propose_document_retrieval: eligibleProposal,
  propose_ingestion_settings: eligibleProposal,
  prepare_ingestion_settings: eligibleProposal,
  prepare_agent_settings: eligibleProposal,
  propose_workspace_setting: deferredProposal,
  start_crawl: deferredProposal,
  propose_directive_enablement: eligibleProposal,
  propose_directive_removal: eligibleProposal,
  propose_routine: eligibleProposal,
  propose_routine_edit: eligibleProposal,
  propose_routine_exposure: eligibleProposal,
  propose_skill_config: eligibleProposal,
  quality_signals: eligibleRead,
  replay_eval_case: contextDependent,
  recrawl_source: unsafeAct,
  reprocess_document: unsafeAct,
  retrieval_probe: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:probe",
    retry: { effect: "none", idempotent: false, operationIdentity: "client" },
  },
  retrieval_settings: eligibleRead,
  prepare_retrieval_settings: eligibleProposal,
  proposal_detail: eligibleRead,
  prepare_document_import: eligibleProposal,
  prepare_document_removal: eligibleProposal,
  prepare_document_reprocess: eligibleProposal,
  prepare_routine_structure: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:propose",
    retry: { effect: "proposal", idempotent: true, operationIdentity: "client" },
  },
  agent_publication_state: eligibleRead,
  prepare_agent_publication: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:propose",
    retry: { effect: "proposal", idempotent: true, operationIdentity: "client" },
  },
  agent_publication_candidate: eligibleRead,
  agent_publication_candidate_change: eligibleRead,
  routine_definition: eligibleRead,
  run_eval_suite: unsafeAct,
  // CAS-fenced by `expectedVersion`: a lost-response retry either moves the version once or comes
  // back `conflict` against the row a competing write already produced, so no owning-module
  // reconciliation hook is needed the way a create-shaped proposal or act needs one.
  set_triage_state: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:act",
    retry: { effect: "act", idempotent: true, operationIdentity: "client" },
  },
  test_agent_turn: contextDependent,
  // Test Chat's reads scope by the request's own agent and session ids, the same explicit shape as
  // the conversation readers.
  test_chat_sessions: eligibleRead,
  test_chat_transcript: eligibleRead,
  test_chat_turn_trace: eligibleRead,
  // One agent turn per call, like retrieval_probe: it spends model budget and leaves a session
  // behind, so a retry runs a second turn unless the client keys it with an operation id. Skill
  // effects are always suppressed, so a turn has no outward effect to reconcile.
  send_test_chat_message: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:probe",
    retry: { effect: "none", idempotent: false, operationIdentity: "client" },
  },
  turn_trace: eligibleRead,
  validate_routine: eligibleRead,
  workspace_settings: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:read",
    retry: { effect: "none", idempotent: true, operationIdentity: "client" },
  },
  // Scopes from the request's own `agentId` alone; it never falls back to dashboard page context
  // (triage.ts explicitly avoids that so a broad "what needs my attention" query is not silently
  // narrowed by whatever the operator happened to have open). No stateless-transport gap exists.
  workspace_triage: eligibleRead,
};

export const assertOperatorMcpDispositionRegistry = (
  descriptorNames: readonly string[],
  dispositions: Readonly<Record<string, CopilotMcpDisposition>> = operatorMcpDispositions,
): void => {
  const names = new Set(descriptorNames);
  const dispositionNames = new Set(Object.keys(dispositions));
  const missing = [...names].filter((name) => !dispositionNames.has(name));
  if (missing.length > 0) throw new Error(`Missing operator MCP disposition: ${missing.sort().join(", ")}`);
  const stale = [...dispositionNames].filter((name) => !names.has(name));
  if (stale.length > 0) throw new Error(`Stale operator MCP disposition: ${stale.sort().join(", ")}`);
  for (const [name, disposition] of Object.entries(dispositions)) {
    if (disposition.status === "excluded" && disposition.reason.trim().length === 0) {
      throw new Error(`Operator MCP exclusion reason is blank: ${name}`);
    }
  }
};

/**
 * An input-derived key turns every identical call into a replay of the first, which only an
 * idempotent act that reconciles from its first attempt's receipt can answer with a real result;
 * replay recovery admits nothing else. Checked over the assembled catalog, contributed descriptors
 * included, because a violation otherwise surfaces as an empty replay in the middle of an
 * operator's retry.
 */
export const assertOperatorMcpOperationIdentities = (descriptors: ReadonlyArray<CopilotToolDescriptor>): void => {
  for (const descriptor of descriptors) {
    const disposition = descriptor.mcpDisposition;
    if (disposition?.status !== "eligible" || disposition.retry.operationIdentity !== "input") continue;
    if (disposition.retry.effect !== "act" || !disposition.retry.idempotent || !descriptor.reconcileMcpInvocation) {
      throw new Error(`Operator MCP tool "${descriptor.name}" keys its replay by its input, which requires an idempotent act with a reconcileMcpInvocation hook.`);
    }
  }
};

export const attachOperatorMcpDispositions = (
  descriptors: ReadonlyArray<CopilotToolDescriptor>,
): ReadonlyArray<CopilotToolDescriptor> => {
  assertOperatorMcpDispositionRegistry(descriptors.map((descriptor) => descriptor.name));
  return descriptors.map((descriptor) => ({
    ...descriptor,
    mcpDisposition: operatorMcpDispositions[descriptor.name],
  }));
};
