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
      "agent_skills",
      "context_variables",
      "conversation_history_search",
      "conversation_transcript",
      "document_chunks",
      "document_search",
      "document_status",
      "eval_results",
      "propose_agent_setting",
      "propose_context_variable",
      "propose_directive",
      "propose_directive_enablement",
      "propose_directive_removal",
      "propose_ingestion_settings",
      "propose_routine",
      "propose_routine_edit",
      "propose_routine_lifecycle",
      "propose_skill_config",
      "quality_signals",
      "retrieval_probe",
      "routine_definition",
      "set_triage_state",
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
