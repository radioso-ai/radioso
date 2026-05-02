import { describe, expect, it } from "vitest";

import {
  capabilityNames,
  DefaultAllowCapabilityPolicy,
  StrictCapabilityPolicy,
  assertKnownCapabilityName,
} from "../../src/shared/domain/capabilityPolicy.js";

describe("capability policy", () => {
  it("allows current product actions by default", async () => {
    const policy = new DefaultAllowCapabilityPolicy();

    await expect(policy.can({
      capability: capabilityNames.documents.delete,
      workspaceId: "workspace-1",
      subjectId: "doc-1",
    })).resolves.toEqual({
      allowed: true,
    });
  });

  it("can deny a named capability through a stricter policy", async () => {
    const policy = new StrictCapabilityPolicy({
      deniedCapabilities: [capabilityNames.documents.delete],
    });

    await expect(policy.can({
      capability: capabilityNames.documents.delete,
      workspaceId: "workspace-1",
      subjectId: "doc-1",
    })).resolves.toEqual({
      allowed: false,
      reason: "capability_denied",
    });
  });

  it("rejects unknown capability names", () => {
    expect(() => assertKnownCapabilityName("documents.launch")).toThrow(
      'Unknown capability "documents.launch"',
    );
  });
});
