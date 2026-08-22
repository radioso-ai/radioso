import { describe, expect, it } from "vitest";

import {
  formatParityGateSuccess,
  formatParityTargetResolutionFailure,
} from "../../../scripts/verifyCanonicalVectorParity.js";

describe("canonical vector parity CLI output", () => {
  it("renders JSON mode as one standalone JSON document", () => {
    const reports = [{ workspaceId: "workspace-1", eligibleChunks: 5, failures: [] }];

    const output = formatParityGateSuccess(reports, true);

    expect(JSON.parse(output)).toEqual(reports);
    expect(output).not.toContain("All 1 workspace");
  });

  it("describes the strict zero-loss evidence in human mode", () => {
    expect(formatParityGateSuccess([{ eligibleChunks: 5 }], false)).toContain(
      "no legacy results were lost and every compared top result matched",
    );
  });

  it("passes an empty database as explicitly zero-risk", () => {
    expect(formatParityGateSuccess([], false)).toContain(
      "no workspace has eligible chunks",
    );
  });

  it("names every requested workspace id that could not be resolved", () => {
    expect(formatParityTargetResolutionFailure({
      unresolvedWorkspaceIds: ["missing-a", "missing-b"],
      missingActiveSpaceWorkspaceIds: [],
    })).toContain("missing-a, missing-b");
  });

  it("names eligible workspaces that have no active cosine space", () => {
    expect(formatParityTargetResolutionFailure({
      unresolvedWorkspaceIds: [],
      missingActiveSpaceWorkspaceIds: ["unprofiled-a"],
    })).toContain("unprofiled-a");
  });
});
