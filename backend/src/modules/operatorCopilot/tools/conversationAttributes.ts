import { z } from "zod";

import type { AttributeEditActor, ConversationAttributeEdits } from "../../context-variables/public.js";
import type { CopilotToolDescriptor, CopilotToolInvocationContext } from "../contracts.js";
import { conversationAttributeSchema, projectConversationAttribute } from "./conversationAttributeProjection.js";
import { entity } from "./shared.js";

export interface ConversationAttributeCopilotToolDependencies {
  /** The edit service the Inbox's routes call, so Ray and operator MCP refuse and record what the Inbox does. */
  readonly conversationAttributeEdits: Pick<ConversationAttributeEdits, "set" | "reset">;
}

const targetFields = {
  conversationId: z.string().uuid(),
  name: z.string().min(1).max(120),
};
// A number or a yes/no is taken as its text, so a set of a typed attribute meets the edit's own
// refusal, which says setting picks a Choice's option and any other type is only cleared, rather
// than a bare schema error that names no reason.
const setInputSchema = z.object({ ...targetFields, value: z.union([z.string().min(1).max(120), z.number(), z.boolean()]) }).strict();
const resetInputSchema = z.object(targetFields).strict();

const outputSchema = z.object({
  /** The attribute as the conversation reads it after the edit; null when no rung holds a value. */
  attribute: conversationAttributeSchema.nullable(),
  classificationQueued: z.boolean(),
}).strict();

type SetInput = z.infer<typeof setInputSchema>;
type ResetInput = z.infer<typeof resetInputSchema>;
type Output = z.infer<typeof outputSchema>;

const setDescription = "Set a Choice attribute on one conversation, as the operator: value is the option key, as context_variables lists it, not its label. The value is the conversation's own, overrides one set for the visitor's session or customer, and the AI never replaces it. Setting the option the AI chose keeps it so; setting the one already set by a teammate changes nothing. A Private attribute, or one that is not a Choice, is refused: clear a Number, Date or Yes/no value with reset_conversation_attribute. conversation_transcript reads the result.";
const resetDescription = "Reset a conversation's own value of an attribute of any type, such as a wrong value a routine saved. When the conversation's agent fills the attribute with the AI, the AI is asked to fill it again now and classificationQueued is true; otherwise the value is cleared, and a value set for the visitor's session or customer shows through. A conversation with no value of its own is left as it is. A Private attribute is refused.";

const ACT_PERMISSIONS = ["workspace.history.read", "workspace.conversation.takeover"] as const;

const actorOf = (context: CopilotToolInvocationContext): AttributeEditActor => ({
  accountId: context.accountId,
  userId: context.operatorUserId,
  surface: context.surface === "mcp" ? "mcp" : "ray",
});

const project = (result: Awaited<ReturnType<ConversationAttributeEdits["set"]>>): Output => ({
  attribute: result.attribute ? projectConversationAttribute(result.attribute) : null,
  classificationQueued: result.classificationQueued,
});

const setTool = (deps: ConversationAttributeCopilotToolDependencies): CopilotToolDescriptor<SetInput, Output> => ({
  name: "set_conversation_attribute",
  shape: "act",
  verificationCost: () => 0,
  uiLabel: "Setting a conversation's attribute",
  contributingModule: "contextVariables",
  dashboardSubject: { type: "conversation" },
  requiredPermissions: [...ACT_PERMISSIONS],
  description: setDescription,
  inputSchema: setInputSchema,
  outputSchema,
  createTool: (context) => ({
    name: "set_conversation_attribute",
    description: setDescription,
    inputSchema: setInputSchema,
    outputSchema,
    invoke: async ({ conversationId, name, value }) => project(await deps.conversationAttributeEdits.set({
      workspaceId: context.workspaceId,
      conversationId,
      name,
      value: String(value),
      actor: actorOf(context),
    })),
  }),
  describeEntity: (input) => entity("conversation", input.conversationId),
});

const resetTool = (deps: ConversationAttributeCopilotToolDependencies): CopilotToolDescriptor<ResetInput, Output> => ({
  name: "reset_conversation_attribute",
  shape: "act",
  verificationCost: () => 0,
  uiLabel: "Resetting a conversation's attribute",
  contributingModule: "contextVariables",
  dashboardSubject: { type: "conversation" },
  requiredPermissions: [...ACT_PERMISSIONS],
  description: resetDescription,
  inputSchema: resetInputSchema,
  outputSchema,
  createTool: (context) => ({
    name: "reset_conversation_attribute",
    description: resetDescription,
    inputSchema: resetInputSchema,
    outputSchema,
    invoke: async ({ conversationId, name }) => project(await deps.conversationAttributeEdits.reset({
      workspaceId: context.workspaceId,
      conversationId,
      name,
      actor: actorOf(context),
    })),
  }),
  describeEntity: (input) => entity("conversation", input.conversationId),
});

/**
 * A teammate's set of one conversation's Choice attribute and reset of any it can see, the same edit the Inbox makes:
 * the takeover permission, the operator as writer, and the service's refusals passed through as they
 * come. The conversation is always named, since an MCP client has no page to take it from.
 */
export const createConversationAttributeCopilotTools = (
  deps: ConversationAttributeCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor<SetInput, Output> | CopilotToolDescriptor<ResetInput, Output>> => [setTool(deps), resetTool(deps)];
