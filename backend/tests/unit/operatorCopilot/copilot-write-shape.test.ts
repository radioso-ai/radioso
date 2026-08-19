import { describe, expect, it } from "vitest";

import { copilotToolAnnotationsForShape } from "../../../src/modules/operatorCopilot/toolShape.js";
import { copilotNeverList, neverListExclusion } from "../../../src/modules/operatorCopilot/neverList.js";

describe("operator copilot write shapes", () => {
  it("derives MCP annotation hints without adding MCP plumbing", () => {
    expect(copilotToolAnnotationsForShape("read")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(copilotToolAnnotationsForShape("probe")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(copilotToolAnnotationsForShape("act")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(copilotToolAnnotationsForShape("propose")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it("enumerates actions Ray must never perform and supplies reusable exclusions", () => {
    expect(Object.keys(copilotNeverList)).toEqual([
      "workspace_delete",
      "agent_delete",
      "member_management",
      "access_grants",
      "secret_rotation",
      "provider_credential_writes",
      "embedding_model_switch_without_typed_confirmation",
      "unattended_live_customer_reply",
    ]);
    expect(neverListExclusion("workspace_delete")).toMatchObject({
      disposition: "permanent",
      neverListEntry: "workspace_delete",
      reason: copilotNeverList.workspace_delete.reason,
    });
  });
});
