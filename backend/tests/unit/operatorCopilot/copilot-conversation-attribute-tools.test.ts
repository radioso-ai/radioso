import { describe, expect, it, vi } from "vitest";

import type { ConversationAttribute } from "../../../src/modules/context-variables/public.js";
import { createConversationAttributeCopilotTools } from "../../../src/modules/operatorCopilot/tools/conversationAttributes.js";
import type { ConversationAttributeCopilotToolDependencies } from "../../../src/modules/operatorCopilot/tools/conversationAttributes.js";
import type { CopilotToolDescriptor } from "../../../src/modules/operatorCopilot/contracts.js";
import { notFound } from "../../../src/shared/domain/errors.js";

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

const contextOn = (surface: "dashboard" | "mcp") => ({
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "history" as const, agentId: null, conversationId: null, selection: null, entities: [] },
});

const attribute: ConversationAttribute = {
  name: "topic",
  valueType: "enum",
  value: "billing",
  option: { label: "Billing", archived: false },
  redacted: false,
  scope: "conversation",
  writtenBy: { kind: "operator", ref: "operator-1" },
  updatedAt: new Date("2026-11-22T10:00:00.000Z"),
  classified: true,
};

const dependencies = (): ConversationAttributeCopilotToolDependencies & {
  conversationAttributeEdits: { set: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };
} => ({
  conversationAttributeEdits: {
    set: vi.fn(async () => ({ attribute, classificationQueued: false })),
    reset: vi.fn(async () => ({ attribute: null, classificationQueued: true })),
  },
});

const toolNamed = (deps: ConversationAttributeCopilotToolDependencies, name: string): CopilotToolDescriptor => {
  const descriptor = createConversationAttributeCopilotTools(deps).find((candidate) => candidate.name === name);
  if (!descriptor) throw new Error(`No ${name} tool`);
  return descriptor;
};

describe("set_conversation_attribute and reset_conversation_attribute (#1884)", () => {
  it("declares two acts that take the takeover permission, as the Inbox's edit does", () => {
    const deps = dependencies();

    for (const name of ["set_conversation_attribute", "reset_conversation_attribute"]) {
      expect(toolNamed(deps, name)).toMatchObject({
        shape: "act",
        contributingModule: "contextVariables",
        requiredPermissions: ["workspace.history.read", "workspace.conversation.takeover"],
        dashboardSubject: { type: "conversation" },
      });
      expect(toolNamed(deps, name).description.length).toBeLessThan(2_048);
    }
  });

  it("sets the option as the operator, through the edit service, and returns the attribute as the transcript shows it", async () => {
    const deps = dependencies();

    const result = await toolNamed(deps, "set_conversation_attribute")
      .createTool(contextOn("mcp"))
      .invoke({ conversationId: CONVERSATION_ID, name: "topic", value: "billing" }, {} as never);

    expect(deps.conversationAttributeEdits.set).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: CONVERSATION_ID,
      name: "topic",
      value: "billing",
      actor: { accountId: "account-1", userId: "operator-1", surface: "mcp" },
    });
    expect(result).toEqual({
      attribute: {
        name: "topic",
        valueType: "enum",
        value: "billing",
        option: { label: "Billing", archived: false },
        redacted: false,
        truncated: false,
        scope: "conversation",
        writtenBy: { kind: "operator", ref: "operator-1" },
        updatedAt: "2026-11-22T10:00:00.000Z",
        classified: true,
      },
      classificationQueued: false,
    });
  });

  it("resets as the operator on Ray's surface, and says when the AI was asked to fill it", async () => {
    const deps = dependencies();

    const result = await toolNamed(deps, "reset_conversation_attribute")
      .createTool(contextOn("dashboard"))
      .invoke({ conversationId: CONVERSATION_ID, name: "topic" }, {} as never);

    expect(deps.conversationAttributeEdits.reset).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      conversationId: CONVERSATION_ID,
      name: "topic",
      actor: { accountId: "account-1", userId: "operator-1", surface: "ray" },
    });
    expect(result).toEqual({ attribute: null, classificationQueued: true });
  });

  it("lets the service's refusal through, so the caller reads its reason", async () => {
    const deps = dependencies();
    deps.conversationAttributeEdits.set.mockRejectedValueOnce(notFound("No attribute is named urgency"));

    await expect(toolNamed(deps, "set_conversation_attribute")
      .createTool(contextOn("mcp"))
      .invoke({ conversationId: CONVERSATION_ID, name: "urgency", value: "high" }, {} as never))
      .rejects.toMatchObject({ statusCode: 404, message: "No attribute is named urgency" });
  });

  it("requires an explicit conversation id, since an MCP client has no page", () => {
    const schema = toolNamed(dependencies(), "set_conversation_attribute").inputSchema;

    expect(schema.safeParse({ name: "topic", value: "billing" }).success).toBe(false);
    expect(schema.safeParse({ conversationId: CONVERSATION_ID, name: "topic", value: "billing" }).success).toBe(true);
  });
});
