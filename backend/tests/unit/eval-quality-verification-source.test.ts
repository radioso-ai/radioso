import { describe, expect, it, vi } from "vitest";

import { EvalQualityVerificationSource } from "../../src/app/composition/adapters/evalQualityVerificationSource.js";
import type { QualityVerification } from "../../src/modules/quality/composition.js";

describe("EvalQualityVerificationSource", () => {
  it("deduplicates and looks up Quality verification evidence in batches of at most 100", async () => {
    const assistantMessageIds = Array.from(
      { length: 205 },
      (_, index) => `assistant_${String(index).padStart(3, "0")}`,
    );
    const lookupVerifications = vi.fn(async (
      _workspaceId: string,
      batch: string[],
    ): Promise<ReadonlyMap<string, QualityVerification>> => new Map(batch.map((id) => [id, {
      caseId: `case_${id}`,
      caseStatus: "passing" as const,
      latestRunStatus: "pass" as const,
      latestRunAt: "2026-08-02T10:00:00.000Z",
    }])));
    const source = new EvalQualityVerificationSource({ lookupVerifications });

    const result = await source.getByAssistantMessageIds("workspace_1", [
      ...assistantMessageIds,
      assistantMessageIds[0]!,
    ]);

    expect(lookupVerifications.mock.calls.map(([, batch]) => batch.length)).toEqual([100, 100, 5]);
    expect(lookupVerifications.mock.calls.every(([workspaceId]) => workspaceId === "workspace_1"))
      .toBe(true);
    expect(result).toHaveLength(205);
    expect(result.get("assistant_000")).toMatchObject({
      caseId: "case_assistant_000",
      caseStatus: "passing",
    });
  });
});
