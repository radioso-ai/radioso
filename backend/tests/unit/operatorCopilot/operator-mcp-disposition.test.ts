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

  it("admits the limited read, probe, and proposal catalog only", () => {
    const eligible = Object.entries(operatorMcpDispositions)
      .filter(([, disposition]) => disposition.status === "eligible")
      .map(([name]) => name)
      .sort();
    expect(eligible).toEqual(["propose_ingestion_settings", "retrieval_probe", "workspace_settings"]);
  });

  it("requires safe metadata for eligibility and a reason for exclusion", () => {
    for (const disposition of Object.values(operatorMcpDispositions)) {
      if (disposition.status === "excluded") {
        expect(disposition.reason.trim().length).toBeGreaterThan(0);
      } else {
        expect(disposition.inputStrategy).toBe("explicit");
        expect(disposition.retry.effect).toMatch(/^(none|proposal)$/);
      }
    }
  });

  it("rejects missing, stale, and blank registry entries", () => {
    expect(() => assertOperatorMcpDispositionRegistry(["workspace_settings"], {})).toThrow(/missing/i);
    expect(() => assertOperatorMcpDispositionRegistry([], { stale: { status: "excluded", reason: "old" } })).toThrow(/stale/i);
    expect(() => assertOperatorMcpDispositionRegistry(["x"], { x: { status: "excluded", reason: " " } })).toThrow(/reason/i);
  });
});
