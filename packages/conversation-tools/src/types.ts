export const CONVERSATION_TOOLS_ADAPTER = "conversation-tools";

// Tool-backed skill contracts live in @radioso/conversation-contract so a host can
// implement them without depending on these adapters; re-exported here because the
// adapters in this package are their primary implementations.
export type {
  ConversationToolDefinition,
  ToolCallContext,
  ToolCallInput,
  ToolCallResult,
  ToolService,
  ToolSkillDefinition,
  ToolSkillDefinitionOptions,
  ToolSkillDispatchResult,
  ToolSkillEmitPort,
  ToolSkillExecutorPort,
  ToolSkillInvocation,
  ToolSkillMetadata,
} from "@radioso/conversation-contract";
