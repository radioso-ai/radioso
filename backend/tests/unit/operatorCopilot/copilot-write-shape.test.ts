import { describe, expect, it } from "vitest";

import { copilotToolAnnotationsForShape } from "../../../src/modules/operatorCopilot/toolShape.js";
import { buildCopilotNeverListContext, copilotNeverList, neverListExclusion } from "../../../src/modules/operatorCopilot/neverList.js";

describe("operator copilot write shapes", () => {
  it("derives MCP annotation hints without adding MCP plumbing", () => {
    expect(copilotToolAnnotationsForShape("read")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    // A probe changes no operator-managed configuration, but it spends real model budget and
    // leaves a record of having run. A transport told "read-only, idempotent" is entitled to
    // auto-run it and to retry it, and each retry is another billed turn and another row.
    expect(copilotToolAnnotationsForShape("probe")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(copilotToolAnnotationsForShape("act")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(copilotToolAnnotationsForShape("propose")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it("enumerates actions Ray must never perform and supplies reusable exclusions", () => {
    expect(Object.keys(copilotNeverList)).toEqual([
      "workspace_delete",
      "agent_delete",
      "member_management",
      "access_grants",
      "machine_access",
      "secret_rotation",
      "provider_credential_writes",
      "embedding_model_switch_without_typed_confirmation",
      "unattended_live_customer_reply",
      "live_conversation_ownership",
      "pending_decision_resolution",
    ]);
    expect(neverListExclusion("workspace_delete")).toMatchObject({
      disposition: "permanent",
      neverListEntry: "workspace_delete",
      reason: copilotNeverList.workspace_delete.reason,
    });
  });

  it("builds trusted, workspace-scoped handoff context for every never-list boundary", () => {
    expect(buildCopilotNeverListContext("acme")).toEqual([
      {
        boundary: "workspace_delete",
        reason: copilotNeverList.workspace_delete.reason,
        dashboardUrl: "/w/acme/settings",
      },
      expect.objectContaining({ boundary: "agent_delete", dashboardUrl: "/w/acme/agents" }),
      expect.objectContaining({ boundary: "member_management", dashboardUrl: "/w/acme/settings" }),
      expect.objectContaining({ boundary: "access_grants", dashboardUrl: "/w/acme/settings" }),
      expect.objectContaining({ boundary: "machine_access", dashboardUrl: "/w/acme/settings" }),
      expect.objectContaining({ boundary: "secret_rotation", dashboardUrl: "/w/acme/settings" }),
      expect.objectContaining({ boundary: "provider_credential_writes", dashboardUrl: "/w/acme/settings" }),
      expect.objectContaining({ boundary: "embedding_model_switch_without_typed_confirmation", dashboardUrl: "/w/acme/settings" }),
      expect.objectContaining({ boundary: "unattended_live_customer_reply", dashboardUrl: "/w/acme/activity" }),
      expect.objectContaining({ boundary: "live_conversation_ownership", dashboardUrl: "/w/acme/activity" }),
      expect.objectContaining({ boundary: "pending_decision_resolution", dashboardUrl: "/w/acme/activity" }),
    ]);
  });

  it("points a conversation-scoped boundary at the conversation the operator is on", () => {
    // The three conversation boundaries otherwise all hand over the same bare queue link, which is
    // coarser than what the turn already knows. Measured live, Ray answered those refusals by
    // naming the conversation's raw UUID and dropping the link — a worse handoff than the id it was
    // holding. Binding the link to the focused conversation gives it something worth writing.
    const bound = buildCopilotNeverListContext("acme", { conversationId: "77d5efb4-3354-4ede-9a2c-4f22778c689b" });

    expect(bound).toEqual(expect.arrayContaining([
      expect.objectContaining({
        boundary: "unattended_live_customer_reply",
        dashboardUrl: "/w/acme/activity?itemKind=chat&itemId=77d5efb4-3354-4ede-9a2c-4f22778c689b",
      }),
      expect.objectContaining({
        boundary: "live_conversation_ownership",
        dashboardUrl: "/w/acme/activity?itemKind=chat&itemId=77d5efb4-3354-4ede-9a2c-4f22778c689b",
      }),
      expect.objectContaining({
        boundary: "pending_decision_resolution",
        dashboardUrl: "/w/acme/activity?itemKind=chat&itemId=77d5efb4-3354-4ede-9a2c-4f22778c689b",
      }),
    ]));
    // Boundaries that are not about a conversation are untouched by what the operator is viewing.
    expect(bound.find((entry) => entry.boundary === "secret_rotation")?.dashboardUrl).toBe("/w/acme/settings");
  });

  it("falls back to the queue when no conversation is on screen", () => {
    expect(buildCopilotNeverListContext("acme", { conversationId: null })
      .find((entry) => entry.boundary === "live_conversation_ownership")?.dashboardUrl)
      .toBe("/w/acme/activity");
  });
});
