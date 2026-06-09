import { describe, expect, it } from "vitest";

import { TOOL_CATALOG, createCapabilityPolicyRegistry } from "../src/policy/capabilityPolicy.js";
import { createWorkspacePolicyResolver } from "../src/policy/workspacePolicy.js";

describe("capability policy", () => {
  it("exposes read and write tools with approval requirements", () => {
    const policy = createCapabilityPolicyRegistry({
      allowedReadTools: ["describe_capabilities", "search_documents"],
      allowedWriteTools: ["create_document", "delete_document"],
      approvalRequiredWriteTools: ["create_document"],
    });

    expect(policy.listCapabilities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accessMode: "read",
          name: "search_documents",
          requiresApproval: false,
        }),
        expect.objectContaining({
          accessMode: "write",
          name: "create_document",
          requiresApproval: true,
        }),
      ]),
    );
    expect(policy.isToolAllowed("search_documents")).toBe(true);
    expect(policy.isToolAllowed("update_retrieval_settings")).toBe(false);
    expect(policy.requiresApproval("create_document")).toBe(true);
  });

  it("does not include removed retrieval settings tools in the catalog", () => {
    expect(TOOL_CATALOG).not.toHaveProperty("get_retrieval_settings");
    expect(TOOL_CATALOG).not.toHaveProperty("update_retrieval_settings");
    expect(() =>
      createCapabilityPolicyRegistry({
        allowedReadTools: ["get_retrieval_settings"],
        allowedWriteTools: [],
        approvalRequiredWriteTools: [],
      }),
    ).toThrow(/Unknown tool names.*get_retrieval_settings/i);
  });

  it("filters requested tools to the configured allowlist and reports denials", () => {
    const policy = createCapabilityPolicyRegistry({
      allowedReadTools: ["describe_capabilities", "search_documents"],
      allowedWriteTools: ["create_document"],
      approvalRequiredWriteTools: ["create_document"],
    });

    expect(
      policy.resolveRequestedTools(["describe_capabilities", "search_documents", "update_document"]),
    ).toEqual({
      approvalRequiredTools: [],
      deniedTools: ["update_document"],
      grantedTools: ["describe_capabilities", "search_documents"],
    });
  });

  it("applies workspace-specific policy overrides without mutating the global catalog", () => {
    const resolver = createWorkspacePolicyResolver(
      {
        allowedReadTools: ["describe_capabilities", "search_documents", "list_documents"],
        allowedWriteTools: ["create_document", "update_document"],
        approvalRequiredWriteTools: ["create_document", "update_document"],
      },
      {
        "3f3caef3-050c-46a7-8fd7-2fa48f17fe98": {
          allowedReadTools: ["describe_capabilities"],
          allowedWriteTools: ["create_document"],
          approvalRequiredWriteTools: ["create_document"],
        },
      },
    );

    expect(resolver.resolve().policy.configuredTools().sort()).toEqual([
      "create_document",
      "describe_capabilities",
      "list_documents",
      "search_documents",
      "update_document",
    ]);
    expect(
      resolver.resolve("3f3caef3-050c-46a7-8fd7-2fa48f17fe98").policy.configuredTools().sort(),
    ).toEqual(["create_document", "describe_capabilities"]);
  });
});
