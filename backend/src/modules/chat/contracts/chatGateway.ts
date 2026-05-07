import type { MessageRecord } from "../../../db/repositories/messageRepository.js";

export interface ChatGateway {
  answer(input: {
    query: string;
    history: MessageRecord[];
    prompt: string;
    systemPrompt?: string;
  }): Promise<string>;
  streamAnswer(input: {
    query: string;
    history: MessageRecord[];
    prompt: string;
    systemPrompt?: string;
  }): AsyncIterable<string>;
}
