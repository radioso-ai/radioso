import type { CopilotMcpDisposition, CopilotToolDescriptor } from "./contracts.js";

const excluded = (reason: string): CopilotMcpDisposition => ({ status: "excluded", reason });

const contextDependent = excluded("Requires dashboard or Ray-conversation context that the stateless operator transport does not provide.");
const deferredRead = excluded("Read descriptor awaits a separate bounded-output and explicit-input MCP review after the limited rollout.");
const deferredProposal = excluded("Proposal descriptor awaits transport-neutral evidence and target-specific MCP review after the limited rollout.");
const unsafeAct = excluded("Act has no owner-approved lost-response, reconciliation, cancellation, and multi-instance MCP contract; GA gate remains closed.");
const customerReply = excluded("Customer reply drafting remains conversation-context behavior and is not part of the initial direct-tool catalog.");

export const operatorMcpDispositions: Readonly<Record<string, CopilotMcpDisposition>> = {
  agent_configuration: deferredRead,
  agent_skills: deferredRead,
  analyze_website: contextDependent,
  audience_topics: deferredRead,
  context_variables: deferredRead,
  conversation_history_search: deferredRead,
  conversation_transcript: deferredRead,
  create_eval_case_from_turn: unsafeAct,
  draft_reply: customerReply,
  document_chunks: deferredRead,
  document_search: deferredRead,
  document_status: deferredRead,
  eval_results: deferredRead,
  needs_attention: contextDependent,
  propose_agent: deferredProposal,
  propose_agent_setting: deferredProposal,
  propose_context_variable: deferredProposal,
  propose_directive: deferredProposal,
  propose_document: deferredProposal,
  propose_document_removal: deferredProposal,
  propose_document_retrieval: deferredProposal,
  propose_ingestion_settings: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:propose",
    retry: { effect: "proposal", idempotent: true, requiresOperationId: true },
  },
  start_crawl: deferredProposal,
  propose_directive_enablement: deferredProposal,
  propose_directive_removal: deferredProposal,
  propose_routine: deferredProposal,
  propose_routine_edit: deferredProposal,
  propose_routine_lifecycle: deferredProposal,
  propose_skill_config: deferredProposal,
  quality_signals: deferredRead,
  replay_eval_case: contextDependent,
  recrawl_source: unsafeAct,
  reprocess_document: unsafeAct,
  retrieval_probe: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:probe",
    retry: { effect: "none", idempotent: false, requiresOperationId: false },
  },
  routine_definition: deferredRead,
  run_eval_suite: unsafeAct,
  set_triage_state: unsafeAct,
  test_agent_turn: contextDependent,
  turn_trace: deferredRead,
  validate_routine: deferredRead,
  workspace_settings: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:read",
    retry: { effect: "none", idempotent: true, requiresOperationId: false },
  },
  workspace_triage: contextDependent,
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

export const attachOperatorMcpDispositions = (
  descriptors: ReadonlyArray<CopilotToolDescriptor>,
): ReadonlyArray<CopilotToolDescriptor> => {
  assertOperatorMcpDispositionRegistry(descriptors.map((descriptor) => descriptor.name));
  return descriptors.map((descriptor) => ({
    ...descriptor,
    mcpDisposition: operatorMcpDispositions[descriptor.name],
  }));
};
