import type { ConversationMessage } from "@radioso/conversation-contract";

import type { OpenAIChatMessage } from "./openAiTypes.js";

const metadataString = (
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const toolCallId = (message: ConversationMessage): string => {
  const id = metadataString(message.metadata, "toolCallId");
  if (!id) {
    // Proper tool-role support needs a contract field for the provider tool_call_id.
    throw new Error(
      "openai_tool_role_unsupported: tool-role messages require a tool_call_id; not yet supported",
    );
  }
  return id;
};

export const toOpenAIChatMessage = (message: ConversationMessage): OpenAIChatMessage => {
  switch (message.role) {
    case "system":
    case "user":
    case "assistant":
      return { role: message.role, content: message.content };
    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: toolCallId(message),
      };
  }
};

export const toOpenAIChatMessages = (input: {
  systemPrompt?: string;
  messages: ConversationMessage[];
}): OpenAIChatMessage[] => {
  const messages = input.messages.map(toOpenAIChatMessage);
  return input.systemPrompt
    ? [{ role: "system", content: input.systemPrompt }, ...messages]
    : messages;
};
