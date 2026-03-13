import type { MessageRecord } from "../../../db/repositories/messageRepository.js";

export class QueryRewriteService {
  async rewrite(input: {
    query: string;
    history: MessageRecord[];
    enabled: boolean;
  }): Promise<string> {
    if (!input.enabled || input.history.length === 0) {
      return input.query;
    }

    const recentUserMessages = input.history
      .filter((message) => message.role === "user")
      .slice(-2)
      .map((message) => message.content.trim())
      .filter(Boolean);

    if (recentUserMessages.length === 0) {
      return input.query;
    }

    return `${recentUserMessages.join(" ")} ${input.query}`.trim();
  }
}
