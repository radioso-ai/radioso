import { describe, expect, it } from "vitest";

import {
  summarizeProposalEvidence,
  type CopilotProposalEvidence,
} from "../../../src/modules/operatorCopilot/proposalEvidence.js";

const evidence = (cases: CopilotProposalEvidence["cases"]): CopilotProposalEvidence => ({ cases });

const measured = (
  before: "pending" | "passing" | "failing" | "error",
  after: "pass" | "fail" | "error" | "recorded",
  stale = false,
) => ({ caseId: "case", caseName: "Refund window", runId: "run", before, after, stale });

describe("proposal evidence summary", () => {
  it("counts a case the change fixed as improved", () => {
    expect(summarizeProposalEvidence(evidence([measured("failing", "pass")])))
      .toMatchObject({ total: 1, improved: 1, regressed: 0, unchanged: 0 });
  });

  it("counts a case the change broke as regressed rather than hiding it", () => {
    // The honest review is "fixed two, broke one". A summary that only counted fixes would sell
    // the proposal instead of describing it.
    expect(summarizeProposalEvidence(evidence([
      measured("failing", "pass"),
      measured("failing", "pass"),
      measured("passing", "fail"),
    ]))).toMatchObject({ total: 3, improved: 2, regressed: 1, unchanged: 0 });
  });

  it("treats an errored replay of a passing case as a regression", () => {
    expect(summarizeProposalEvidence(evidence([measured("passing", "error")])))
      .toMatchObject({ regressed: 1, improved: 0 });
  });

  it("counts a still-failing case as unchanged, not as a fix", () => {
    expect(summarizeProposalEvidence(evidence([measured("failing", "fail")])))
      .toMatchObject({ improved: 0, regressed: 0, unchanged: 1 });
  });

  it("does not read an unscored replay as a fix", () => {
    // "recorded" means the case had no assertions, so the replay proved nothing about it.
    expect(summarizeProposalEvidence(evidence([measured("failing", "recorded")])))
      .toMatchObject({ improved: 0, regressed: 0, unchanged: 1 });
  });

  it("counts a case whose agent moved after the replay as stale", () => {
    expect(summarizeProposalEvidence(evidence([
      measured("failing", "pass", true),
      measured("failing", "pass"),
    ]))).toMatchObject({ total: 2, improved: 2, stale: 1 });
  });

  it("summarizes an absent measurement as nothing rather than as a pass", () => {
    expect(summarizeProposalEvidence(evidence([])))
      .toMatchObject({ total: 0, improved: 0, regressed: 0, unchanged: 0, stale: 0 });
  });
});
