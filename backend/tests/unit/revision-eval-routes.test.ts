import { describe, expect, it } from "vitest";

import type { EvalCase } from "../../src/modules/eval/domain/types.js";
import { revisionEvalEvidenceStateForCase } from "../../src/modules/eval/routes/revisionEvalRoutes.js";

const baseCase = (overrides: Partial<EvalCase> = {}): EvalCase => ({
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  snapshotId: "00000000-0000-4000-8000-000000000003",
  name: "case",
  assertions: [],
  executionMode: "safe_test",
  status: "pending",
  lastRunId: null,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  ...overrides,
});

describe("revision eval route evidence", () => {
  it("keeps matching case configuration comparability-unknown while live dependencies are untracked", () => {
    const frozen = baseCase();

    expect(revisionEvalEvidenceStateForCase(baseCase(), frozen)).toBe("comparability_unknown");
  });

  it("downgrades evidence to configuration-changed when the current case differs", () => {
    const frozen = baseCase();

    expect(revisionEvalEvidenceStateForCase(baseCase({ assertions: [{ type: "answer_contains", pattern: "changed", matchMode: "substring" }] }), frozen)).toBe("configuration_changed");
    expect(revisionEvalEvidenceStateForCase(null, frozen)).toBe("configuration_changed");
  });
});
