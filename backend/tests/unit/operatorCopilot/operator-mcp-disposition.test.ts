import { describe, expect, it } from "vitest";

import { copilotCapabilityProvenance } from "../../../src/modules/operatorCopilot/capabilityProvenance.js";
import {
  assertOperatorMcpDispositionRegistry,
  operatorMcpDispositions,
} from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";

describe("operator MCP descriptor disposition", () => {
  it("is an exhaustive bijection with the production descriptor registry", () => {
    expect(() => assertOperatorMcpDispositionRegistry(Object.keys(copilotCapabilityProvenance))).not.toThrow();
    expect(Object.keys(operatorMcpDispositions).sort()).toEqual(Object.keys(copilotCapabilityProvenance).sort());
  });

  it("admits the limited read, probe, act, and proposal catalog only", () => {
    const eligible = Object.entries(operatorMcpDispositions)
      .filter(([, disposition]) => disposition.status === "eligible")
      .map(([name]) => name)
      .sort();
    expect(eligible).toEqual([
      "agent_configuration",
      "agent_publication_candidate",
      "agent_publication_candidate_change",
      "agent_publication_state",
      "agent_skills",
      "cancel_reviewed_proposal",
      "context_variables",
      "conversation_history_search",
      "conversation_transcript",
      "document_chunks",
      "document_search",
      "document_status",
      "eval_results",
      "execute_reviewed_proposal",
      "list_documents",
      "prepare_agent_publication",
      "prepare_agent_settings",
      "prepare_directive",
      "prepare_document_import",
      "prepare_document_removal",
      "prepare_document_reprocess",
      "prepare_ingestion_settings",
      "prepare_retrieval_settings",
      "prepare_routine_structure",
      "proposal_detail",
      "propose_agent_setting",
      "propose_context_variable",
      "propose_directive",
      "propose_directive_enablement",
      "propose_directive_removal",
      "propose_document",
      "propose_document_retrieval",
      "propose_greeting",
      "propose_ingestion_settings",
      "propose_routine",
      "propose_routine_edit",
      "propose_routine_exposure",
      "propose_skill_config",
      "quality_signals",
      "retrieval_probe",
      "retrieval_settings",
      "reviewed_proposal_outcome",
      "routine_definition",
      "send_test_chat_message",
      "set_triage_state",
      "test_chat_sessions",
      "test_chat_transcript",
      "test_chat_turn_trace",
      "turn_trace",
      "validate_routine",
      "workspace_settings",
      "workspace_triage",
    ]);
  });

  it("requires safe metadata for eligibility and a reason for exclusion", () => {
    for (const disposition of Object.values(operatorMcpDispositions)) {
      if (disposition.status === "excluded") {
        expect(disposition.reason.trim().length).toBeGreaterThan(0);
      } else {
        expect(disposition.inputStrategy).toBe("explicit");
        expect(disposition.retry.effect).toMatch(/^(none|proposal|act)$/);
      }
    }
  });

  it("rejects missing, stale, and blank registry entries", () => {
    expect(() => assertOperatorMcpDispositionRegistry(["workspace_settings"], {})).toThrow(/missing/i);
    expect(() => assertOperatorMcpDispositionRegistry([], { stale: { status: "excluded", reason: "old" } })).toThrow(/stale/i);
    expect(() => assertOperatorMcpDispositionRegistry(["x"], { x: { status: "excluded", reason: " " } })).toThrow(/reason/i);
  });
});
